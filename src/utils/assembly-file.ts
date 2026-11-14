/**
 * 程序集（.dll）文件的选择、读取与"最近文件"记忆。
 *
 * 最近文件历史按程序集分组保存在 assembly-file-history 中；本模块负责与宿主文件系统交互：
 * 选择文件、读取内容，并在每次用到历史记录时按磁盘实时状态校验（大小、修改时间重新读取，
 * 确认不存在的记录被清理）。浏览器降级路径（<input type="file">）拿不到路径，不写入历史。
 */

import { readRecentRecords, rememberAssemblyFile, writeRecentRecords } from "./assembly-file-history";
import { bytesToBase64 } from "./base64";
import { readFileInfoFromShell } from "./file-meta";

/** 原生文件对话框的 DLL 过滤条件 */
const DLL_FILE_FILTERS = [{ name: "Assembly", extensions: ["dll"] }];

/** 已选程序集文件的元信息；除 path 外均由磁盘实时读取或本次操作产生，不落盘 */
export interface AssemblyFileInfo {
    /** 磁盘绝对路径 */
    path: string;
    /** 文件名，含 .dll 扩展名 */
    name: string;
    /** 文件字节大小（实时读取） */
    size: number;
    /** 文件最后修改时间（实时读取，毫秒时间戳） */
    modifiedAt: number;
    /** 文件在系统上的添加日期（异步补齐，毫秒时间戳；0 表示暂时读不到） */
    addedAt: number;
}

/** 已读取的程序集文件 */
export interface LoadedAssemblyFile {
    info: AssemblyFileInfo;
    /** Base64 编码的文件内容，可直接提交给 Dataverse */
    content: string;
}

/** 宿主是否提供原生文件选择与读取能力（Power Platform ToolBox / Electron） */
export function isNativeFilePickerAvailable(): boolean {
    // 类型声明把 fileSystem 标为必选，但浏览器预览环境下整个 toolboxAPI 都不存在，故按运行时探测
    const fileSystem = window.toolboxAPI?.fileSystem;
    return typeof fileSystem?.selectPath === "function"
        && typeof fileSystem?.readBinary === "function"
        && typeof fileSystem?.stat === "function";
}

/** 从路径中取出文件名 */
function fileNameOf(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

/** 兼容宿主返回的二进制载荷形态（Uint8Array / ArrayBuffer / Node Buffer 序列化后的对象） */
function toBytes(payload: unknown): Uint8Array {
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    const serialized = payload as { data?: unknown } | null;
    // Electron 主进程 Buffer 序列化后可能变成 { type: "Buffer", data: number[] }
    if (serialized && Array.isArray(serialized.data)) return new Uint8Array(serialized.data as number[]);
    throw new Error("Unsupported binary payload returned by the host.");
}

/** 把字节数格式化为便于阅读的大小（如 1.2 MB） */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    // 逐级换算到合适的单位，最大到 GB，避免超大文件显示成天文数字 KB
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * 按磁盘实时状态校验指定程序集的最近文件列表：大小与修改时间重新读取。
 * 只有确认文件已不存在（exists 为 false）或路径已不再是文件时才清理记录；
 * 元信息暂时读不到（权限、宿主异常等）时保留记录，避免一次读取异常就丢掉整份历史。
 */
export async function refreshRecentAssemblyFiles(scope: string): Promise<AssemblyFileInfo[]> {
    const records = readRecentRecords(scope);
    if (records.length === 0) return [];
    // 宿主不支持读取磁盘时无法校验，保留历史记录，避免环境异常时丢数据
    if (!isNativeFilePickerAvailable()) return [];

    const fileSystem = window.toolboxAPI.fileSystem;
    const verified = await Promise.all<AssemblyFileInfo | null>(records.map(async (record) => {
        try {
            const stat = await fileSystem.stat(record.path);
            if (stat.type !== "file") { // 路径已变成目录等非文件对象：不再可用
                console.warn("[assembly-file] 最近文件路径已不是文件，将从列表中移除:", record.path);
                return null;
            }
            const modifiedAt = Date.parse(stat.mtime);
            return {
                path: record.path,
                name: fileNameOf(record.path),
                size: stat.size,
                // mtime 解析失败时退化为 0，界面显示为未修改时间
                modifiedAt: Number.isNaN(modifiedAt) ? 0 : modifiedAt,
                addedAt: 0,
            };
        } catch (e) { // 元信息读取失败：可能是宿主重启后访问授权失效，先改用终端读真实属性
            const shellInfo = await readFileInfoFromShell(record.path);
            if (shellInfo?.meta) {
                console.warn("[assembly-file] fileSystem 读取被拒，已通过终端取到文件属性:", record.path, e);
                return {
                    path: record.path,
                    name: fileNameOf(record.path),
                    size: shellInfo.meta.size,
                    modifiedAt: shellInfo.meta.modifiedAt,
                    addedAt: shellInfo.meta.addedAt,
                };
            }
            // 终端确认文件已不存在：直接移除记录
            if (shellInfo && !shellInfo.exists) {
                console.warn("[assembly-file] 最近文件已不存在，将从列表中移除:", record.path);
                return null;
            }
            // 终端也判断不了：再问 fileSystem 是否存在，连它都失败时保守保留记录
            let exists: boolean;
            try {
                exists = await fileSystem.exists(record.path);
            } catch (existsError) {
                console.warn("[assembly-file] 检查最近文件是否存在失败，保留记录:", record.path, existsError);
                exists = true;
            }
            if (exists) {
                console.warn("[assembly-file] 无法读取最近文件的元信息，保留记录:", record.path, e);
                return { path: record.path, name: fileNameOf(record.path), size: 0, modifiedAt: 0, addedAt: 0 };
            }
            console.warn("[assembly-file] 最近文件已不存在，将从列表中移除:", record.path, e);
            return null;
        }
    }));

    const existing = verified.filter((item): item is AssemblyFileInfo => item !== null);
    if (existing.length !== records.length) {
        // 只保留校验通过的记录，原有排序与使用时间保持不变
        const keptPaths = new Set(existing.map((item) => item.path));
        writeRecentRecords(scope, records.filter((record) => keptPaths.has(record.path)));
    }
    return existing;
}

/** 通过宿主文件系统 API 读取指定路径的 DLL，大小与修改时间实时取自磁盘 */
async function readAssemblyFileFromPath(path: string): Promise<LoadedAssemblyFile> {
    const fileSystem = window.toolboxAPI.fileSystem;
    const stat = await fileSystem.stat(path);
    if (stat.type !== "file") throw new Error("The selected path is not a file.");
    const payload: unknown = await fileSystem.readBinary(path);
    const modifiedAt = Date.parse(stat.mtime);
    return {
        // mtime 解析失败时退化为 0；addedAt 需要额外系统命令，由界面异步补齐
        info: {
            path,
            name: fileNameOf(path),
            size: stat.size,
            modifiedAt: Number.isNaN(modifiedAt) ? 0 : modifiedAt,
            addedAt: 0,
        },
        content: bytesToBase64(toBytes(payload)),
    };
}

/**
 * 打开原生文件对话框选择 DLL 并读取内容；用户取消时返回 null。
 * defaultPath 用于把对话框定位到上次选中的文件所在目录，重新选择时不必再逐层翻目录。
 */
export async function pickAssemblyFile(scope: string, defaultPath?: string): Promise<LoadedAssemblyFile | null> {
    const path = await window.toolboxAPI.fileSystem.selectPath({
        type: "file",
        title: "Select Assembly File",
        filters: DLL_FILE_FILTERS,
        defaultPath,
    });
    if (!path) return null;
    if (!path.toLowerCase().endsWith(".dll")) throw new Error("Please select a .dll file.");
    const loaded = await readAssemblyFileFromPath(path);
    // 只记入当前程序集的历史，其他程序集的文件列表不受影响
    rememberAssemblyFile(scope, path, Date.now());
    return loaded;
}

/** 读取某个历史路径对应的磁盘内容；宿主不支持或文件已不存在时返回 null */
/** 读取磁盘文件的结果：失败时保留宿主的原始错误，便于界面说清为什么读不到 */
export interface AssemblyFileLoadResult {
    /** 读取成功时的文件内容；失败为 null */
    file: LoadedAssemblyFile | null;
    /** 失败原因（宿主返回的错误信息），成功时为空 */
    error?: string;
}

/** 读取某个历史路径对应的磁盘内容；读不到时把宿主的原始错误一并带回 */
export async function loadAssemblyFile(path: string): Promise<AssemblyFileLoadResult> {
    if (!path) return { file: null, error: "No file path was recorded." };
    if (!isNativeFilePickerAvailable()) return { file: null, error: "This host does not provide file access." };
    try {
        return { file: await readAssemblyFileFromPath(path) };
    } catch (e) { // 文件被删除、移动或权限被拒：返回错误由界面提示重新选择
        console.error("[assembly-file] 读取程序集文件失败:", e);
        return { file: null, error: e instanceof Error ? e.message : String(e) };
    }
}

/** 浏览器降级路径：读取 <input type="file"> 选中的文件内容（拿不到磁盘路径） */
export async function readBrowserAssemblyFile(file: File): Promise<LoadedAssemblyFile> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info: AssemblyFileInfo = {
        path: "",
        name: file.name,
        size: file.size,
        modifiedAt: file.lastModified,
        addedAt: 0,
    };
    return { info, content: bytesToBase64(bytes) };
}
