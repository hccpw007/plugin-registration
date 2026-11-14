/**
 * 程序集（.dll）文件的选择、读取与"最近一次选择"记忆。
 *
 * 宿主提供 Power Platform ToolBox 文件系统 API 时走原生对话框：能拿到磁盘路径，
 * 下次打开对话框可直接读回磁盘上的最新内容（重新编译后就地覆盖的场景最实用）。
 * 未提供时降级到浏览器 <input type="file">：拿不到路径，内容只在当前会话有效，
 * 跨会话只能回显文件名等元信息。
 */

/** localStorage 中保存"最近选择的程序集文件"记录的键名 */
const RECENT_ASSEMBLY_FILE_KEY = "plugin-registration:recent-assembly-file";

/** 原生文件对话框的 DLL 过滤条件 */
const DLL_FILE_FILTERS = [{ name: "Assembly", extensions: ["dll"] }];

/** 单次拼接的字节块大小，避免 String.fromCharCode 参数过长导致调用栈溢出 */
const BASE64_CHUNK_SIZE = 0x8000;

/** 已选程序集文件的元信息 */
export interface AssemblyFileInfo {
    /** 磁盘绝对路径；浏览器降级选择时为空串 */
    path: string;
    /** 文件名，含 .dll 扩展名 */
    name: string;
    /** 文件字节大小 */
    size: number;
    /** 文件最后修改时间（毫秒时间戳） */
    modifiedAt: number;
    /** 该文件加入表单的时间（毫秒时间戳） */
    addedAt: number;
}

/** 已读取的程序集文件；content 为空表示只拿到元信息、内容不可用 */
export interface LoadedAssemblyFile {
    info: AssemblyFileInfo;
    /** Base64 编码的文件内容，可直接提交给 Dataverse */
    content: string;
}

/** 宿主是否提供原生文件选择与读取能力（Power Platform ToolBox / Electron） */
export function isNativeFilePickerAvailable(): boolean {
    // 类型声明把 fileSystem 标为必选，但浏览器预览环境下整个 toolboxAPI 都不存在，故按运行时探测
    const fileSystem = window.toolboxAPI?.fileSystem;
    return typeof fileSystem?.selectPath === "function" && typeof fileSystem?.readBinary === "function";
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

/** 把字节数组编码为 Base64 */
function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
    }
    return btoa(binary);
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

/** 把毫秒时间戳格式化为本地时间 YYYY-MM-DD HH:mm:ss */
export function formatFileTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 读取最近一次选择的文件记录；记录损坏或 localStorage 不可用时按无记录处理 */
function readRecentRecord(): AssemblyFileInfo | null {
    try {
        const raw = localStorage.getItem(RECENT_ASSEMBLY_FILE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<AssemblyFileInfo> | null;
        if (!parsed || typeof parsed.name !== "string") return null;
        return {
            path: typeof parsed.path === "string" ? parsed.path : "",
            name: parsed.name,
            size: typeof parsed.size === "number" ? parsed.size : 0,
            modifiedAt: typeof parsed.modifiedAt === "number" ? parsed.modifiedAt : 0,
            addedAt: typeof parsed.addedAt === "number" ? parsed.addedAt : 0,
        };
    } catch (e) { // 隐私模式或记录损坏：降级为无历史记录，不阻断选文件
        console.warn("[assembly-file] 读取最近选择的文件记录失败:", e);
        return null;
    }
}

/** 记录最近一次选择的文件，供下次打开对话框时回显与恢复 */
function saveRecentAssemblyFile(info: AssemblyFileInfo): void {
    try {
        localStorage.setItem(RECENT_ASSEMBLY_FILE_KEY, JSON.stringify(info));
    } catch (e) { // 配额不足时写入失败不影响本次选择，仅损失下次的自动恢复
        console.warn("[assembly-file] 保存最近选择的文件记录失败:", e);
    }
}

/** 通过宿主文件系统 API 读取指定路径的 DLL；addedAt 为"加入表单"的时间 */
async function readAssemblyFileFromPath(path: string, addedAt: number): Promise<LoadedAssemblyFile> {
    const fileSystem = window.toolboxAPI.fileSystem;
    const stat = await fileSystem.stat(path);
    if (stat.type !== "file") throw new Error("The selected path is not a file.");
    const payload: unknown = await fileSystem.readBinary(path);
    const modifiedAt = Date.parse(stat.mtime);
    return {
        // mtime 解析失败时退化为"当前时间"，避免界面显示 Invalid Date
        info: { path, name: fileNameOf(path), size: stat.size, modifiedAt: Number.isNaN(modifiedAt) ? Date.now() : modifiedAt, addedAt },
        content: bytesToBase64(toBytes(payload)),
    };
}

/** 打开原生文件对话框选择 DLL 并读取内容；用户取消时返回 null */
export async function pickAssemblyFile(): Promise<LoadedAssemblyFile | null> {
    const path = await window.toolboxAPI.fileSystem.selectPath({
        type: "file",
        title: "Select Assembly File",
        filters: DLL_FILE_FILTERS,
    });
    if (!path) return null;
    if (!path.toLowerCase().endsWith(".dll")) throw new Error("Please select a .dll file.");
    const loaded = await readAssemblyFileFromPath(path, Date.now());
    saveRecentAssemblyFile(loaded.info);
    return loaded;
}

/** 浏览器降级路径：读取 <input type="file"> 选中的文件内容（拿不到磁盘路径） */
export async function readBrowserAssemblyFile(file: File): Promise<LoadedAssemblyFile> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info: AssemblyFileInfo = {
        path: "",
        name: file.name,
        size: file.size,
        modifiedAt: file.lastModified,
        addedAt: Date.now(),
    };
    saveRecentAssemblyFile(info);
    return { info, content: bytesToBase64(bytes) };
}

/**
 * 恢复最近一次选择的文件。
 * 记录里有路径且宿主支持读取时，直接从磁盘读回最新内容；否则只返回元信息（content 为空）。
 */
export async function loadRecentAssemblyFile(): Promise<LoadedAssemblyFile | null> {
    const record = readRecentRecord();
    if (!record) return null;
    if (!record.path || !isNativeFilePickerAvailable()) return { info: record, content: "" };
    try {
        if (!(await window.toolboxAPI.fileSystem.exists(record.path))) {
            console.warn("[assembly-file] 上次选择的文件已不存在，需重新选择:", record.path);
            return { info: record, content: "" };
        }
        return await readAssemblyFileFromPath(record.path, record.addedAt);
    } catch (e) { // 文件被移动、权限不足等：回显元信息让用户重新选择，不打断对话框
        console.error("[assembly-file] 恢复上次选择的文件失败:", e);
        return { info: record, content: "" };
    }
}
