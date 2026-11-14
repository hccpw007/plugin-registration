/**
 * 程序集文件的"最近使用"历史存储。
 *
 * 历史按程序集分组保存，只记录磁盘路径与最近使用时间；文件大小、修改时间等易过期信息不落盘，
 * 由 assembly-file 在每次打开对话框时从磁盘实时读取。
 */

/** localStorage 中保存"最近文件"的键名；值为按分组键索引的记录数组（最新在前） */
const RECENT_ASSEMBLY_FILES_KEY = "plugin-registration:recent-assembly-files.v2";

/** 旧版全局共享的列表键：无法区分记录属于哪个程序集，写入时清理，避免跨程序集选错文件 */
const LEGACY_RECENT_ASSEMBLY_FILES_KEY = "plugin-registration:recent-assembly-files";

/** 更早版本保存单条记录的键名，同样无法区分程序集，一并清理 */
const LEGACY_RECENT_ASSEMBLY_FILE_KEY = "plugin-registration:recent-assembly-file";

/** 最近文件记录上限（每个程序集单独计算），避免 localStorage 无限增长 */
const MAX_RECENT_ASSEMBLY_FILES = 10;

/** 注册新程序集时还没有程序集 id，用一个固定分组保存它的历史 */
export const NEW_ASSEMBLY_FILE_SCOPE = "__new-assembly__";

/** 持久化的最近文件记录：只保存路径与最近使用时间 */
export interface RecentAssemblyFileRecord {
    /** 磁盘绝对路径 */
    path: string;
    /** 最近一次被选用的时间，用于排序（毫秒时间戳） */
    lastUsedAt: number;
}

/** 已按分组键存放的最近文件记录：键是程序集 id（或新程序集分组），值为该程序集的历史 */
type RecentAssemblyFileStore = Record<string, RecentAssemblyFileRecord[]>;

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

/** 读取全部历史；记录损坏或 localStorage 不可用时返回空对象 */
function readStore(): RecentAssemblyFileStore {
    try {
        const raw = localStorage.getItem(RECENT_ASSEMBLY_FILES_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const store: RecentAssemblyFileStore = {};
        for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(value)) continue;
            const records = value
                .map(normalizeRecord)
                .filter((record): record is RecentAssemblyFileRecord => record !== null);
            // 空分组不保留，避免存储里堆积空数组
            if (records.length > 0) store[scope] = records;
        }
        return store;
    } catch (e) { // 隐私模式或记录损坏：降级为无历史记录，不阻断选文件
        console.warn("[assembly-file] 读取最近选择的文件记录失败:", e);
        return {};
    }
}

/** 写回全部历史；没有任何记录时清除存储，避免残留空对象 */
function writeStore(store: RecentAssemblyFileStore): void {
    try {
        const entries = Object.entries(store).filter(([, records]) => records.length > 0);
        if (entries.length === 0) {
            localStorage.removeItem(RECENT_ASSEMBLY_FILES_KEY);
        } else {
            localStorage.setItem(RECENT_ASSEMBLY_FILES_KEY, JSON.stringify(Object.fromEntries(entries)));
        }
        // 清掉无法区分程序集的旧键，避免旧记录被误当成当前程序集的历史
        localStorage.removeItem(LEGACY_RECENT_ASSEMBLY_FILES_KEY);
        localStorage.removeItem(LEGACY_RECENT_ASSEMBLY_FILE_KEY);
    } catch (e) { // 配额不足时写入失败不影响本次选择，仅损失下次的自动恢复
        console.warn("[assembly-file] 保存最近选择的文件记录失败:", e);
    }
}

/** 读取指定程序集的最近文件记录（最新在前） */
export function readRecentRecords(scope: string): RecentAssemblyFileRecord[] {
    return readStore()[scope] ?? [];
}

/** 写回指定程序集的最近文件记录，其他程序集的历史保持不变 */
export function writeRecentRecords(scope: string, records: RecentAssemblyFileRecord[]): void {
    const store = readStore();
    if (records.length === 0) {
        delete store[scope];
    } else {
        store[scope] = records;
    }
    writeStore(store);
}

/** 把文件置为指定程序集的最近使用（同一路径去重并前移），只记录路径与使用时间 */
export function rememberAssemblyFile(scope: string, path: string, usedAt: number): void {
    const others = readRecentRecords(scope).filter((record) => record.path.toLowerCase() !== path.toLowerCase());
    writeRecentRecords(scope, [{ path, lastUsedAt: usedAt }, ...others].slice(0, MAX_RECENT_ASSEMBLY_FILES));
}
