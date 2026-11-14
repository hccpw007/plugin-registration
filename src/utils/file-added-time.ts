/**
 * 读取文件在系统上的"添加日期"（macOS Finder 的"添加日期"列）。
 *
 * 宿主的 fileSystem API 只返回 type / size / mtime，没有添加时间或创建时间，
 * 因此借用终端执行系统命令获取：macOS 用 Spotlight 元数据 kMDItemDateAdded（读不到时退化为 birthtime），
 * Windows 用 CreationTime，Linux 用 birthtime。任何一步失败都返回 null，界面显示为未知，不影响其它信息。
 */

/** 单条命令的等待上限，避免终端无响应时一直挂起 */
const COMMAND_TIMEOUT_MS = 5000;

/** 命令输出中用来截取结果块的标记，避免把 shell 回显混进结果 */
const START_MARKER = "__ADDED_AT__";
const END_MARKER = "__ADDED_END__";

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

/** 拼出各平台的取时间命令，结果包在标记之间便于截取 */
function buildCommand(platform: "darwin" | "win32" | "linux", path: string): string {
    const quoted = quotePath(path);
    if (platform === "win32") {
        // CreationTime 是文件的创建时间，Windows 资源管理器"创建日期"同源
        return `powershell -NoProfile -Command "Write-Output '${START_MARKER}'; `
            + `(Get-Item ${quoted}).CreationTime.ToString('yyyy-MM-dd HH:mm:ss'); Write-Output '${END_MARKER}'"`;
    }
    if (platform === "linux") {
        // %W 是 birthtime（秒），多数文件系统会给出 0 表示不支持
        return `printf '${START_MARKER}'; stat -c %W ${quoted} 2>/dev/null; printf '${END_MARKER}'`;
    }
    // macOS：Spotlight 的 kMDItemDateAdded 就是 Finder"添加日期"；取不到时退化为 birthtime
    return `printf '${START_MARKER}'; `
        + `(mdls -name kMDItemDateAdded -raw ${quoted} 2>/dev/null || stat -f "%B" ${quoted}); `
        + `printf '${END_MARKER}'`;
}

/** 把命令输出解析成毫秒时间戳；无法解析时返回 null */
function parseOutput(output: string): number | null {
    // 去掉终端颜色控制字符与回车，PTY 输出里常见
    const clean = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
    const start = clean.lastIndexOf(START_MARKER);
    const end = clean.lastIndexOf(END_MARKER);
    if (start < 0 || end <= start) return null;
    const raw = clean.slice(start + START_MARKER.length, end).trim();
    if (!raw || raw === "(null)") return null;
    // birthtime 以秒级时间戳返回（Linux、macOS 的 stat -f %B）
    if (/^\d+$/.test(raw)) {
        const seconds = Number(raw);
        return seconds > 0 ? seconds * 1000 : null;
    }
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
}

/** 执行命令并取回输出；超时或宿主不支持时返回 null */
async function runCommand(command: string): Promise<string | null> {
    const terminalAPI = window.toolboxAPI?.terminal;
    if (!terminalAPI) return null;
    let terminalId: string | null = null;
    try {
        const terminal = await terminalAPI.create({ name: "assembly-file-info", visible: false });
        terminalId = terminal.id;
        const result = await Promise.race([
            terminalAPI.execute(terminalId, command),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), COMMAND_TIMEOUT_MS)),
        ]);
        return result?.output ?? null;
    } catch (e) { // 终端不可用或被拒绝授权：视为读不到，不阻断其它流程
        console.warn("[file-added-time] 通过终端读取文件添加时间失败:", e);
        return null;
    } finally {
        if (terminalId) void terminalAPI.close(terminalId).catch(() => undefined);
    }
}

/** 读取文件的添加日期（毫秒时间戳），每次都实时向系统查询；无法获取时返回 null */
export async function readFileAddedTime(path: string): Promise<number | null> {
    if (!path) return null;
    const platform = detectPlatform();
    if (!platform) return null;
    const output = await runCommand(buildCommand(platform, path));
    if (!output) return null;
    return parseOutput(output);
}
