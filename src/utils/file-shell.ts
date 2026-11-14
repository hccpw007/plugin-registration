/**
 * 通过宿主终端执行系统命令并取回输出。
 *
 * Power Platform ToolBox 的 fileSystem 访问授权只对当前工具实例有效（进程重启或工具重开后失效），
 * 而终端命令不受该路径授权限制，因此文件元信息在 fileSystem 被拒时改由终端读取。
 * 终端实例按需创建并复用，避免每次调用都新建隐藏终端。
 */

/** 单条命令的等待上限，避免终端无响应时一直挂起 */
const COMMAND_TIMEOUT_MS = 8000;

/** 复用的终端实例 id；执行失败时丢弃并重建 */
let terminalId: string | null = null;

/** 执行结果：成功时 output 为命令输出，失败时 error 说明原因 */
export interface ShellResult {
    output: string | null;
    error?: string;
}

/** 取得（必要时创建）一个隐藏终端 */
async function ensureTerminal(): Promise<string | null> {
    const api = window.toolboxAPI?.terminal;
    if (!api) return null;
    if (terminalId) return terminalId;
    try {
        const terminal = await api.create({ name: "file-info", visible: false });
        terminalId = terminal.id;
        return terminalId;
    } catch (e) { // 终端不可用或被拒绝授权：由调用方降级
        console.warn("[file-shell] 创建终端失败:", e);
        return null;
    }
}

/** 执行一条命令并返回输出；任何异常都转成 error 字段，不向上抛 */
export async function runShell(command: string): Promise<ShellResult> {
    const api = window.toolboxAPI?.terminal;
    if (!api) return { output: null, error: "This host does not provide a terminal." };
    const id = await ensureTerminal();
    if (!id) return { output: null, error: "The terminal is not available for this tool." };
    try {
        const result = await Promise.race([
            api.execute(id, command),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), COMMAND_TIMEOUT_MS)),
        ]);
        if (!result) {
            terminalId = null; // 超时：丢弃终端实例，下次重建
            return { output: null, error: "The command timed out." };
        }
        if (result.error) return { output: null, error: result.error };
        return { output: result.output ?? null };
    } catch (e) { // 终端被关闭或执行通道异常：丢弃实例，下次重建
        console.warn("[file-shell] 执行命令失败:", e);
        terminalId = null;
        return { output: null, error: e instanceof Error ? e.message : String(e) };
    }
}

/** 关闭复用的终端；读完大段内容后调用，避免终端面板里残留一屏 base64 */
export async function closeShellTerminal(): Promise<void> {
    const api = window.toolboxAPI?.terminal;
    const id = terminalId;
    terminalId = null;
    if (!api || !id) return;
    try {
        await api.close(id);
    } catch (e) { // 终端可能已被用户关闭：记录即可，不影响后续读取
        console.warn("[file-shell] 关闭终端失败:", e);
    }
}

/** 从命令输出中截取两个标记之间的内容；命令回显里的标记在前，故取最后一次出现 */
export function extractBlock(output: string, startMarker: string, endMarker: string): string | null {
    // 去掉终端颜色控制字符与回车，PTY 输出里常见
    const clean = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
    const start = clean.lastIndexOf(startMarker);
    const end = clean.lastIndexOf(endMarker);
    if (start < 0 || end <= start) return null;
    return clean.slice(start + startMarker.length, end);
}

/**
 * 取出标记所在行的剩余内容。
 *
 * 宿主用哨兵行判断命令结束，若输出末尾没有换行，最后一段会和哨兵拼成同一行被整体丢弃，
 * 因此命令一律写成「标记 + 内容 + 换行」的单行输出，这里按行解析。
 */
export function extractMarkedLine(output: string, marker: string): string | null {
    const clean = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
    const index = clean.lastIndexOf(marker);
    if (index < 0) return null;
    const rest = clean.slice(index + marker.length);
    const lineEnd = rest.indexOf("\n");
    return (lineEnd < 0 ? rest : rest.slice(0, lineEnd)).trim();
}
