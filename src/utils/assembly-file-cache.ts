/**
 * 最近文件内容的本地缓存。
 *
 * Power Platform ToolBox 的文件访问授权（ToolFilesystemAccessManager）只存在于当前工具实例内且不落盘：
 * 进程退出或工具重新打开后，历史路径的 stat / readBinary 都会被拒绝。
 * 因此这里缓存每个程序集最近一次选中的 dll 内容，仅在磁盘读取失败时作为回退，
 * 界面会标注这是缓存副本，避免误以为是最新编译结果。
 */

import type { LoadedAssemblyFile } from "./assembly-file";

const DB_NAME = "plugin-registration-assembly-cache";
const DB_VERSION = 1;
const STORE_NAME = "files";

/** 缓存在 IndexedDB 中的一条程序集文件快照 */
export interface CachedAssemblyFile {
    /** 程序集分组键，与最近文件历史一致 */
    scope: string;
    /** 磁盘绝对路径 */
    path: string;
    name: string;
    size: number;
    modifiedAt: number;
    /** 写入缓存的时间（毫秒时间戳） */
    cachedAt: number;
    /** Base64 文件内容 */
    content: string;
}

/** 打开缓存数据库；IndexedDB 不可用时返回 null（隐私模式等），由调用方降级 */
function openDatabase(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
            console.warn("[assembly-file] IndexedDB 不可用，跳过文件缓存:", e);
            resolve(null);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "scope" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            console.warn("[assembly-file] 打开文件缓存数据库失败:", request.error);
            resolve(null);
        };
    });
}

/** 缓存某个程序集最近一次读取到的文件内容（每个程序集只保留一份） */
export async function saveCachedAssemblyFile(scope: string, loaded: LoadedAssemblyFile): Promise<void> {
    const db = await openDatabase();
    if (!db) return;
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readwrite");
            transaction.objectStore(STORE_NAME).put({
                scope,
                path: loaded.info.path,
                name: loaded.info.name,
                size: loaded.info.size,
                modifiedAt: loaded.info.modifiedAt,
                cachedAt: Date.now(),
                content: loaded.content,
            } satisfies CachedAssemblyFile);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    } catch (e) { // 缓存失败不影响本次选择，仅损失下次重启后的回退能力
        console.warn("[assembly-file] 缓存文件内容失败:", e);
    } finally {
        db.close();
    }
}

/** 读取某个程序集的缓存快照；路径不一致（已改选其他文件）或没有缓存时返回 null */
export async function readCachedAssemblyFile(scope: string, path: string): Promise<CachedAssemblyFile | null> {
    const db = await openDatabase();
    if (!db) return null;
    try {
        const cached = await new Promise<CachedAssemblyFile | null>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readonly");
            const request = transaction.objectStore(STORE_NAME).get(scope);
            request.onsuccess = () => resolve((request.result as CachedAssemblyFile | undefined) ?? null);
            request.onerror = () => reject(request.error);
        });
        return cached && cached.path === path ? cached : null;
    } catch (e) {
        console.warn("[assembly-file] 读取文件缓存失败:", e);
        return null;
    } finally {
        db.close();
    }
}
