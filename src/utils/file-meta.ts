/**
 * 通过终端命令读取文件的元信息（大小 / 修改时间 / 添加日期）。
 *
 * 宿主的 fileSystem.stat 只返回 type + size + mtime，且在工具实例重启后被拒绝访问；
 * 这条路径通过系统命令一次取回三个属性，用于 fileSystem 不可用时兜底：
 * macOS 用 stat 取大小与修改时间、mdls 取 Finder 的"添加日期"（Spotlight 未索引时退化为 birthtime），
 * Windows 用 PowerShell 的 Length / LastWriteTime / CreationTime，Linux 用 stat 的 %s / %Y / %W。
 */

import { extractMarkedLine, runShell } from "./file-shell";

/** 命令输出中用来标记结果行的前缀 */
const START_MARKER = "__FILE_META__";

/** 文件的元信息，时间均为毫秒时间戳 */
export interface FileMeta {
    /** 文件字节大小 */
    size: number;
    /** 最后修改时间 */
    modifiedAt: number;
    /** 添加日期（macOS Finder 的"添加日期"）；0 表示读不到 */
    addedAt: number;
}

/** 终端查询结果：文件是否存在，以及能读到的元信息 */
export interface ShellFileInfo {
    /** 文件是否存在；无法判断时为 true，避免误删历史记录 */
    exists: boolean;
    /** 读到的元信息；文件不存在或读取失败时为 null */
    meta: FileMeta | null;
}

/** 文件不存在时，结果行里代替属性内容出现的标记 */
const MISSING_MARKER = "MISSING";

/** 检测文件所在平台；不支持时返回 null */
function detectPlatform(): "darwin" | "win32" | "linux" | null {
    const platform = `${navigator.platform} ${navigator.userAgent}`;
    if (/mac/i.test(platform)) return "darwin";
    if (/win/i.test(platform)) return "win32";
    if (/linux/i.test(platform)) return "linux";
    return null;
}

/** 转义单引号，保证路径能安全放进 shell 的单引号字符串 */
function quotePath(path: string): string {
    return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * 拼出各平台的元信息命令，输出形如 `size|mtime|added|birth`（竖线分隔，便于逐段解析）。
 * birth 只在 added 缺失时使用，两者含义不同：added 是"添加日期"，birth 是"创建时间"。
 * 文件不存在时输出 MISSING 标记，便于和"存在但读不到"区分开。
 */
function buildCommand(platform: "darwin" | "win32" | "linux", path: string): string {
    const quoted = quotePath(path);
    if (platform === "win32") {
        return `powershell -NoProfile -Command "if (Test-Path -LiteralPath ${quoted}) { `
            + `\\$f = Get-Item -LiteralPath ${quoted}; `
            + `Write-Output ('${START_MARKER}' + \\$f.Length + '|' + ([DateTimeOffset]\\$f.LastWriteTime).ToUnixTimeSeconds() `
            + `+ '|' + ([DateTimeOffset]\\$f.CreationTime).ToUnixTimeSeconds() + '|' + ([DateTimeOffset]\\$f.CreationTime).ToUnixTimeSeconds()) `
            + `} else { Write-Output ('${START_MARKER}' + '${MISSING_MARKER}') }"`;
    }
    if (platform === "linux") {
        return `if [ -f ${quoted} ]; then printf '${START_MARKER}%s\\n' `
            + `"$(stat -c '%s|%Y' ${quoted} 2>/dev/null)|$(stat -c %W ${quoted} 2>/dev/null)|`
            + `$(stat -c %W ${quoted} 2>/dev/null)"; else printf '${START_MARKER}${MISSING_MARKER}\\n'; fi`;
    }
    // macOS：mdls 的 kMDItemDateAdded 就是 Finder"添加日期"，末尾再附 birthtime 作为兜底。
    // 整段用一条 printf 输出成单行，避免末尾缺少换行时与宿主的哨兵行合并而被丢弃
    return `if [ -f ${quoted} ]; then printf '${START_MARKER}%s\\n' `
        + `"$(stat -f '%z|%m' ${quoted} 2>/dev/null)|$(mdls -name kMDItemDateAdded -raw ${quoted} 2>/dev/null)|`
        + `$(stat -f %B ${quoted} 2>/dev/null)"; else printf '${START_MARKER}${MISSING_MARKER}\\n'; fi`;
}

/** 把毫秒或秒级时间戳统一成毫秒；无法解析时返回 0 */
function toMillis(raw: string): number {
    const value = raw.trim();
    if (!value || value === "(null)" || value === "-") return 0;
    // 纯数字按秒级时间戳处理（stat 的 %m/%B/%W 都是秒）
    if (/^\d+$/.test(value)) {
        const seconds = Number(value);
        return seconds > 0 ? seconds * 1000 : 0;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/** 解析结果行；无法解析时返回 null */
function parseMetaLine(line: string): FileMeta | null {
    const parts = line.split("|");
    if (parts.length < 2) return null;
    const size = Number(parts[0]);
    if (!Number.isFinite(size) || size < 0) return null;
    const modifiedAt = toMillis(parts[1] ?? "");
    // 添加日期优先取 Spotlight 的值，读不到时用创建时间兜底
    const addedAt = toMillis(parts[2] ?? "") || toMillis(parts[3] ?? "");
    return { size, modifiedAt, addedAt };
}

/** 通过终端读取文件是否存在及其元信息；终端不可用时返回 null */
export async function readFileInfoFromShell(path: string): Promise<ShellFileInfo | null> {
    if (!path) return null;
    const platform = detectPlatform();
    if (!platform) return null;
    const result = await runShell(buildCommand(platform, path));
    if (!result.output) return null;
    // 取最后一次出现的标记：命令回显在前，实际结果在后
    const line = extractMarkedLine(result.output, START_MARKER);
    if (line === null) return null;
    if (line === MISSING_MARKER) return { exists: false, meta: null };
    // 结果行解析不出来时按"文件仍存在"处理，避免因一次解析失败删掉历史记录
    return { exists: true, meta: parseMetaLine(line) };
}
