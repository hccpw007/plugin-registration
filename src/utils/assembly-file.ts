/**
 * 程序集（.dll）文件的选择、读取与"最近文件"记忆。
 *
 * 持久化只保存磁盘路径与最近使用时间：文件大小、修改时间在每次打开对话框时从磁盘实时读取，
 * 已不存在的记录会被自动清理，避免展示过期数据。
 * 浏览器降级路径（<input type="file">）拿不到路径，既无法跨会话恢复内容，也不写入最近文件历史。
 */

/** localStorage 中保存"最近选择的程序集文件"列表的键名（数组，最新在前） */
const RECENT_ASSEMBLY_FILES_KEY = "plugin-registration:recent-assembly-files";

/** 旧版本保存单条记录的键名，读取时作为回退，兼容已存在的历史数据 */
const LEGACY_RECENT_ASSEMBLY_FILE_KEY = "plugin-registration:recent-assembly-file";

/** 最近文件记录上限，避免 localStorage 无限增长 */
const MAX_RECENT_ASSEMBLY_FILES = 10;

/** 原生文件对话框的 DLL 过滤条件 */
const DLL_FILE_FILTERS = [{ name: "Assembly", extensions: ["dll"] }];

/** 单次拼接的字节块大小，避免 String.fromCharCode 参数过长导致调用栈溢出 */
const BASE64_CHUNK_SIZE = 0x8000;

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
    /** 该文件加入当前表单的时间（毫秒时间戳） */
    addedAt: number;
}

/** 持久化的最近文件记录：只保存路径与最近使用时间 */
interface RecentAssemblyFileRecord {
    /** 磁盘绝对路径 */
    path: string;
    /** 最近一次被选用的时间，用于排序（毫秒时间戳） */
    lastUsedAt: number;
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

/** 校验并归一化存储中的一条记录；无磁盘路径的记录（旧版浏览器选择）无法复用，返回 null */
function normalizeRecord(raw: unknown): RecentAssemblyFileRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as { path?: unknown; lastUsedAt?: unknown; addedAt?: unknown };
    const path = typeof record.path === "string" ? record.path : "";
    if (!path) return null;
    // lastUsedAt 为当前格式；addedAt 来自旧版记录，取其选择时间维持排序
    const lastUsedAt = typeof record.lastUsedAt === "number" ? record.lastUsedAt
        : typeof record.addedAt === "number" ? record.addedAt : 0;
    return { path, lastUsedAt };
}

/** 读取最近文件记录（最新在前）；记录损坏或 localStorage 不可用时返回空列表 */
function readRecentRecords(): RecentAssemblyFileRecord[] {
    try {
        const raw = localStorage.getItem(RECENT_ASSEMBLY_FILES_KEY)
            ?? localStorage.getItem(LEGACY_RECENT_ASSEMBLY_FILE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        // 旧版本存的是单条对象，按单元素列表处理以兼容升级前的记录
        const list = Array.isArray(parsed) ? parsed : [parsed];
        return list
            .map(normalizeRecord)
            .filter((record): record is RecentAssemblyFileRecord => record !== null);
    } catch (e) { // 隐私模式或记录损坏：降级为无历史记录，不阻断选文件
        console.warn("[assembly-file] 读取最近选择的文件记录失败:", e);
        return [];
    }
}

/** 写回最近文件记录；空列表时清除存储，避免残留空数组 */
function writeRecentRecords(records: RecentAssemblyFileRecord[]): void {
    try {
        if (records.length === 0) {
            localStorage.removeItem(RECENT_ASSEMBLY_FILES_KEY);
        } else {
            localStorage.setItem(RECENT_ASSEMBLY_FILES_KEY, JSON.stringify(records));
        }
        // 迁移到列表格式后清掉旧键，避免旧记录一直被回退读取
        localStorage.removeItem(LEGACY_RECENT_ASSEMBLY_FILE_KEY);
    } catch (e) { // 配额不足时写入失败不影响本次选择，仅损失下次的自动恢复
        console.warn("[assembly-file] 保存最近选择的文件记录失败:", e);
    }
}

/** 把文件置为最近使用（同一路径去重并前移），只记录路径与使用时间 */
export function rememberAssemblyFile(path: string, usedAt: number): void {
    const others = readRecentRecords().filter((record) => record.path.toLowerCase() !== path.toLowerCase());
    writeRecentRecords([{ path, lastUsedAt: usedAt }, ...others].slice(0, MAX_RECENT_ASSEMBLY_FILES));
}

/**
 * 按磁盘实时状态校验最近文件列表：大小与修改时间重新读取。
 * 只有确认文件已不存在（exists 为 false）或路径已不再是文件时才清理记录；
 * 元信息暂时读不到（权限、宿主异常等）时保留记录，避免一次读取异常就丢掉整份历史。
 */
export async function refreshRecentAssemblyFiles(): Promise<AssemblyFileInfo[]> {
    const records = readRecentRecords();
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
                addedAt: record.lastUsedAt,
            };
        } catch (e) { // 元信息读取失败：先确认文件是否真的不存在，避免误删历史
            let exists: boolean;
            try {
                exists = await fileSystem.exists(record.path);
            } catch (existsError) { // 连存在性都判断不了时保守保留记录
                console.warn("[assembly-file] 检查最近文件是否存在失败，保留记录:", record.path, existsError);
                exists = true;
            }
            if (exists) {
                console.warn("[assembly-file] 无法读取最近文件的元信息，保留记录:", record.path, e);
                return { path: record.path, name: fileNameOf(record.path), size: 0, modifiedAt: 0, addedAt: record.lastUsedAt };
            }
            console.warn("[assembly-file] 最近文件已不存在，将从列表中移除:", record.path, e);
            return null;
        }
    }));

    const existing = verified.filter((item): item is AssemblyFileInfo => item !== null);
    if (existing.length !== records.length) {
        writeRecentRecords(existing.map((item) => ({ path: item.path, lastUsedAt: item.addedAt })));
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
        // mtime 解析失败时退化为 0；addedAt 取读取时刻，即本次加入表单的时间
        info: {
            path,
            name: fileNameOf(path),
            size: stat.size,
            modifiedAt: Number.isNaN(modifiedAt) ? 0 : modifiedAt,
            addedAt: Date.now(),
        },
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
    const loaded = await readAssemblyFileFromPath(path);
    rememberAssemblyFile(path, loaded.info.addedAt);
    return loaded;
}

/** 读取某个历史路径对应的磁盘内容；宿主不支持或文件已不存在时返回 null */
export async function loadAssemblyFile(path: string): Promise<LoadedAssemblyFile | null> {
    if (!path || !isNativeFilePickerAvailable()) return null;
    try {
        return await readAssemblyFileFromPath(path);
    } catch (e) { // 文件被删除、移动或权限不足：返回 null 由界面清理该记录并提示重新选择
        console.error("[assembly-file] 读取程序集文件失败:", e);
        return null;
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
        addedAt: Date.now(),
    };
    return { info, content: bytesToBase64(bytes) };
}
