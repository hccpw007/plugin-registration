import { useState, useRef, useEffect } from "react";

import type { PluginAssembly, PluginPackage } from "../models/interfaces";
import { formatDateTime } from "../utils/datetime";
import {
    formatFileSize,
    isNativeFilePickerAvailable,
    loadAssemblyFile,
    pickAssemblyFile,
    readBrowserAssemblyFile,
    refreshRecentAssemblyFiles,
} from "../utils/assembly-file";
import { NEW_ASSEMBLY_FILE_SCOPE, rememberAssemblyFile } from "../utils/assembly-file-history";
import { readFileInfoFromShell } from "../utils/file-meta";
import { readFileContentFromShell } from "../utils/file-content";
import type { AssemblyFileInfo, LoadedAssemblyFile } from "../utils/assembly-file";
import { SearchableSelect } from "./SearchableSelect";

interface RegisterAssemblyDialogProps {
    isOpen: boolean;
    isUpdate: boolean;
    existingAssembly?: PluginAssembly;
    packages?: PluginPackage[];
    onCreatePackage?: () => void;
    onRegister: (content: string, name: string, isolationMode: number, description: string, packageId: string) => Promise<void>;
    onClose: () => void;
}

const DEFAULT_ISOLATION_MODE = 2; // Sandbox

export function RegisterAssemblyDialog({
    isOpen,
    isUpdate,
    existingAssembly,
    packages = [],
    onCreatePackage,
    onRegister,
    onClose,
}: RegisterAssemblyDialogProps) {
    const [content, setContent] = useState("");
    const [assemblyName, setAssemblyName] = useState("");
    const [isolationMode, setIsolationMode] = useState(DEFAULT_ISOLATION_MODE);
    const [description, setDescription] = useState(existingAssembly?.description ?? "");
    const [packageId, setPackageId] = useState(existingAssembly?._packageid_value ?? "");
    const [saving, setSaving] = useState(false);
    const [fileError, setFileError] = useState("");
    /** 打开弹窗时读取最近文件失败的原因（宿主原始错误），用于说明为什么读不到 */
    const [fileReadError, setFileReadError] = useState("");
    /** 当前选中的 DLL 元信息：用于显示文件大小、添加时间与修改时间 */
    const [selectedFile, setSelectedFile] = useState<AssemblyFileInfo | null>(null);
    /** 最近选择过的 DLL 列表（最新在前），用于在多个程序集之间快速切换 */
    const [recentFiles, setRecentFiles] = useState<AssemblyFileInfo[]>([]);
    /** 当前文件是否由"最近文件"自动带出，用于提示文件来源 */
    const [restoredFromLast, setRestoredFromLast] = useState(false);
    /** 正在从磁盘读取文件（选择或恢复最近文件），期间禁用选择入口 */
    const [readingFile, setReadingFile] = useState(false);
    /** 正在通过终端分块读取文件内容（fileSystem 被拒时的替代通道） */
    const [readingViaShell, setReadingViaShell] = useState(false);
    /** 终端读取内容失败的原因；为空表示没有失败 */
    const [shellReadError, setShellReadError] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);
    const nativePickerAvailable = isNativeFilePickerAvailable();
    // 最近文件按程序集分开记忆：更新时用程序集 id，注册新程序集时用固定分组，
    // 避免把一个程序集的 dll 带到另一个程序集上
    const fileScope = existingAssembly?.pluginassemblyid ?? NEW_ASSEMBLY_FILE_SCOPE;

    /**
     * 显示选中的文件，并异步补齐它的"添加日期"。
     * 添加日期是文件系统属性、宿主 fileSystem API 不提供，需要额外系统命令读取，
     * 因此先渲染已有的信息，读到后再补上；读不到时保持 0，界面显示为未知。
     */
    const fillAddedTime = (info: AssemblyFileInfo, isCancelled: () => boolean = () => false) => {
        // 已经拿到添加日期（例如由历史校验时的终端兜底提供）就不再重复查一次
        if (info.addedAt > 0) return;
        void readFileInfoFromShell(info.path).then((shellInfo) => {
            const addedAt = shellInfo?.meta?.addedAt ?? 0;
            if (isCancelled() || addedAt === 0) return;
            setSelectedFile((current) => (current && current.path === info.path ? { ...current, addedAt } : current));
        });
    };

    /**
     * fileSystem.readBinary 被拒时，改用终端分块读取文件内容。
     * 内容会与磁盘上的 sha256 比对，校验不通过一律不使用，避免提交损坏的 dll。
     */
    const readContentViaShell = (info: AssemblyFileInfo, isCancelled: () => boolean) => {
        if (info.size <= 0) return;
        setReadingViaShell(true);
        void readFileContentFromShell(info.path, info.size).then((result) => {
            if (isCancelled()) return;
            setReadingViaShell(false);
            if (!result.content) {
                console.warn("[RegisterAssemblyDialog] 终端读取文件内容失败:", result.error);
                setShellReadError(result.error ?? "The shell could not read this file.");
                return;
            }
            setShellReadError("");
            setContent(result.content);
            setAssemblyName(info.name.replace(/\.dll$/i, ""));
        });
    };

    // Reset form state whenever the dialog opens or the target assembly changes
    useEffect(() => {
        if (!isOpen) return;
        setContent("");
        setAssemblyName("");
        setIsolationMode(DEFAULT_ISOLATION_MODE);
        setDescription(existingAssembly?.description ?? "");
        setPackageId(existingAssembly?._packageid_value ?? "");
        setSaving(false);
        setFileError("");
        setFileReadError("");
        setShellReadError("");
        setReadingViaShell(false);
        setSelectedFile(null);
        setRestoredFromLast(false);
        if (fileRef.current) fileRef.current.value = "";

        // 每次打开对话框都重新读磁盘：历史记录先按实时状态校验（大小/修改时间重新读取，
        // 确认不存在的记录被清理），再把最近一条的内容读进表单，保证看到的始终是最新的文件
        let cancelled = false;
        setReadingFile(true);
        void (async () => {
            try {
                const files = await refreshRecentAssemblyFiles(fileScope);
                if (cancelled) return;
                setRecentFiles(files);
                const latest = files[0];
                if (!latest) return;
                const loaded = await loadAssemblyFile(latest.path);
                if (cancelled) return;
                if (!loaded.file) {
                    // 宿主重启后 fileSystem 授权失效：先回显实时读到的属性，
                    // 再改用终端读取内容（带 sha256 校验），成功后无需 Browse 即可提交
                    setSelectedFile(latest);
                    setFileReadError(loaded.error ?? "");
                    readContentViaShell(latest, () => cancelled);
                    return;
                }
                setFileReadError("");
                setSelectedFile(loaded.file.info);
                setContent(loaded.file.content);
                setAssemblyName(loaded.file.info.name.replace(/\.dll$/i, ""));
                setRestoredFromLast(true);
                fillAddedTime(loaded.file.info, () => cancelled);
            } catch (e) { // 恢复失败不阻断用户手动选择
                console.error("[RegisterAssemblyDialog] 恢复最近使用的程序集文件失败:", e);
            } finally {
                if (!cancelled) setReadingFile(false);
            }
        })();

        return () => { cancelled = true; };
    }, [isOpen, existingAssembly, fileScope]);

    if (!isOpen) return null;

    /** 把读到的文件应用到表单，并按磁盘实时状态刷新最近文件列表 */
    const applyLoadedFile = async (loaded: LoadedAssemblyFile, fromRecent: boolean) => {
        setFileReadError("");
        setShellReadError("");
        setSelectedFile(loaded.info);
        setContent(loaded.content);
        setAssemblyName(loaded.info.name.replace(/\.dll$/i, ""));
        setRestoredFromLast(fromRecent);
        fillAddedTime(loaded.info);
        setRecentFiles(await refreshRecentAssemblyFiles(fileScope));
    };

    /** 用宿主原生对话框选择 DLL：能拿到磁盘路径，下次打开对话框可自动恢复内容 */
    const handleBrowseFile = async () => {
        setFileError("");
        setReadingFile(true);
        try {
            const loaded = await pickAssemblyFile(fileScope, selectedFile?.path);
            if (!loaded) return; // 用户取消了选择
            await applyLoadedFile(loaded, false);
        } catch (e) {
            console.error("[RegisterAssemblyDialog] 选择程序集文件失败:", e);
            setFileError(e instanceof Error ? e.message : String(e));
        } finally {
            setReadingFile(false);
        }
    };

    /** 从最近文件列表中选择：读回该 DLL 在磁盘上的当前内容，并把它前移为最近使用 */
    const handlePickRecentFile = async (path: string) => {
        setFileError("");
        setReadingFile(true);
        try {
            const loaded = await loadAssemblyFile(path);
            if (!loaded.file) {
                // 读取失败：重新校验列表（refresh 只清理确认不存在的记录），当前文件保持不变
                setRecentFiles(await refreshRecentAssemblyFiles(fileScope));
                setFileError(`Unable to read this file: ${loaded.error ?? "unknown reason"}`);
                const fallback = recentFiles.find((file) => file.path === path);
                if (fallback) readContentViaShell(fallback, () => false);
                return;
            }
            // 选中的文件前移为最近使用
            rememberAssemblyFile(fileScope, path, Date.now());
            await applyLoadedFile(loaded.file, false);
        } catch (e) {
            console.error("[RegisterAssemblyDialog] 读取最近选择的程序集文件失败:", e);
            setFileError("Failed to read the selected file.");
        } finally {
            setReadingFile(false);
        }
    };

    /** 浏览器降级路径：读取 <input type="file"> 选中的 DLL */
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        setFileError("");
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.name.toLowerCase().endsWith(".dll")) {
            setFileError("Please select a .dll file.");
            return;
        }
        try {
            const loaded = await readBrowserAssemblyFile(file);
            await applyLoadedFile(loaded, false);
        } catch (e) {
            console.error("[RegisterAssemblyDialog] 读取程序集文件失败:", e);
            setFileError("Failed to read the file.");
        }
    };

    const handleSubmit = async () => {
        if (!content) { setFileError("Please select a .dll file."); return; }
        setSaving(true);
        try {
            await onRegister(content, assemblyName, isolationMode, description, packageId);
        } finally {
            setSaving(false);
        }
    };

    const title = isUpdate ? `Update Assembly: ${existingAssembly?.name ?? ""}` : "Register New Assembly";

    // 只有带磁盘路径的记录才能读回内容，浏览器降级记录不进"最近文件"下拉；
    // 文件名作为主标签完整显示，大小与修改时间作为灰色小字放在第二行。
    // 元信息可能因权限等原因暂时读不到，此时给出明确提示而不是显示 0 B
    const recentFileOptions = recentFiles
        .filter((file) => file.path)
        .map((file) => ({
            value: file.path,
            label: file.name,
            description: file.size > 0 && file.modifiedAt > 0
                ? `${formatFileSize(file.size)} · ${formatDateTime(file.modifiedAt)}`
                : "File info unavailable",
        }));

    return (
        <div className="dialog-overlay">
            <div className="dialog">
                <div className="dialog-header">
                    <span className="dialog-title">{title}</span>
                    <button
                        className="dialog-close"
                        onClick={onClose}
                        aria-label="Close dialog"
                        title="Close dialog"
                    >✕</button>
                </div>
                <div className="dialog-body">
                    <div className="form-row">
                        <label className="form-label">Assembly File (.dll) *</label>
                        {/* 宿主支持原生对话框时用「最近文件 + Browse」入口；否则回退到原生 file input */}
                        {nativePickerAvailable ? (
                            <div className="form-row-with-browse">
                                {/* 最近文件：可直接切到历史中用过的其他 DLL，支持输入筛选 */}
                                {recentFileOptions.length > 0 && (
                                    <SearchableSelect
                                        value={selectedFile?.path ?? ""}
                                        options={recentFileOptions}
                                        onChange={(path) => void handlePickRecentFile(path)}
                                        placeholder="Choose a recent file…"
                                        emptyText="No recent files"
                                        disabled={saving || readingFile}
                                    />
                                )}
                                {/* 浏览磁盘上的其他 DLL */}
                                <button
                                    type="button"
                                    className="btn-browse"
                                    onClick={() => void handleBrowseFile()}
                                    disabled={saving || readingFile}
                                >
                                    {readingFile ? "Loading…" : "Browse…"}
                                </button>
                            </div>
                        ) : (
                            <input
                                ref={fileRef}
                                type="file"
                                accept=".dll"
                                className="form-input"
                                onChange={(e) => void handleFileChange(e)}
                            />
                        )}
                        {/* 已选文件信息：名称、路径、大小、添加时间、修改时间 */}
                        {selectedFile && (
                            <div className="file-info-card">
                                <div className="file-info-body">
                                    <span className="file-info-name" title={selectedFile.name}>{selectedFile.name}</span>
                                    {selectedFile.path && (
                                        <span className="file-info-path" title={selectedFile.path}>{selectedFile.path}</span>
                                    )}
                                    <span className="file-info-meta">
                                        {selectedFile.size > 0 ? formatFileSize(selectedFile.size) : "Size unavailable"}
                                        {selectedFile.addedAt > 0
                                            ? ` · Added ${formatDateTime(selectedFile.addedAt)}`
                                            : " · Added unavailable"}
                                        {selectedFile.modifiedAt > 0 && ` · Modified ${formatDateTime(selectedFile.modifiedAt)}`}
                                    </span>
                                </div>
                            </div>
                        )}
                        {/* 自动带出的文件标注来源，避免用户以为文件是凭空出现的 */}
                        {restoredFromLast && (
                            <div className="form-hint">Loaded automatically from your recent files.</div>
                        )}
                        {/* fileSystem 被拒时正在改用终端分块读取内容 */}
                        {readingViaShell && !content && (
                            <div className="form-hint">Reading the file through the system shell…</div>
                        )}
                        {/* 两条通道都读不到：说明原因并引导重新选择 */}
                        {selectedFile && !content && !readingViaShell && (
                            <div className="form-hint form-hint-warning">
                                Unable to read this file
                                {shellReadError ? `: ${shellReadError}` : fileReadError ? `: ${fileReadError}` : "."}{" "}
                                Use Browse to re-select it — the dialog opens at the last folder.
                            </div>
                        )}
                        {fileError && <div className="form-hint form-hint-error">{fileError}</div>}
                    </div>
                    {!isUpdate && (
                        <div className="form-row">
                            <label className="form-label">Isolation Mode</label>
                            <select
                                className="form-select"
                                value={isolationMode}
                                onChange={(e) => setIsolationMode(Number(e.target.value))}
                            >
                                <option value={2}>Sandbox</option>
                                <option value={1}>None</option>
                            </select>
                        </div>
                    )}
                    <div className="form-row">
                        <label className="form-label">Description</label>
                        <textarea
                            className="form-textarea"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Optional description"
                        />
                    </div>
                    {packages.length > 0 && (
                        <div className="form-row">
                            <label className="form-label">Package Assignment</label>
                            <select
                                className="form-select"
                                value={packageId}
                                onChange={(e) => setPackageId(e.target.value)}
                            >
                                <option value="">Standalone (no package)</option>
                                {(() => {
                                    // If the assembly's current package is managed, it would be
                                    // filtered out below — render it as a disabled option so the
                                    // controlled <select>'s value still matches a real option and
                                    // the user can see what package the assembly belongs to.
                                    const currentPkg = packageId
                                        ? packages.find((p) => p.pluginpackageid === packageId)
                                        : undefined;
                                    const showCurrentAsDisabled =
                                        !!currentPkg && currentPkg.ismanaged;
                                    return (
                                        <>
                                            {showCurrentAsDisabled && currentPkg && (
                                                <option
                                                    key={currentPkg.pluginpackageid}
                                                    value={currentPkg.pluginpackageid}
                                                    disabled
                                                >
                                                    {currentPkg.name} ({currentPkg.version}) — managed (current)
                                                </option>
                                            )}
                                            {packages
                                                .filter((p) => !p.ismanaged)
                                                .map((p) => (
                                                    <option key={p.pluginpackageid} value={p.pluginpackageid}>
                                                        {p.name} ({p.version})
                                                    </option>
                                                ))}
                                        </>
                                    );
                                })()}
                            </select>
                            {onCreatePackage && (
                                <button
                                    type="button"
                                    className="btn-secondary"
                                    style={{ marginTop: 4, fontSize: 11 }}
                                    onClick={onCreatePackage}
                                >
                                    + Create New Package…
                                </button>
                            )}
                            {isUpdate && existingAssembly?._packageid_value &&
                                !packages.find((p) => p.pluginpackageid === existingAssembly._packageid_value) && (
                                    <span style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                                        Currently in package: {existingAssembly._packageid_value}
                                    </span>
                                )}
                        </div>
                    )}
                </div>
                <div className="dialog-footer">
                    <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
                    {/* 读取期间一律不可提交：即使旧内容还在，也不能拿它去覆盖 */}
                    <button
                        className="btn-primary"
                        onClick={() => void handleSubmit()}
                        disabled={saving || readingViaShell || !content}
                    >
                        {saving ? "Saving…" : readingViaShell ? "Reading…" : isUpdate ? "Update" : "Register"}
                    </button>
                </div>
            </div>
        </div>
    );
}
