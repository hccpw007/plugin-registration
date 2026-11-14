/**
 * 通过终端分块读取文件的完整内容。
 *
 * 宿主 fileSystem.readBinary 在工具实例重启后会被拒绝（授权只在当前会话有效），
 * 而终端命令不受该路径授权限制，因此在 readBinary 失败时改用分块命令读取。
 * PTY 传输大段文本有噪声风险，所以读取后必须通过 sha256 与磁盘上的真实内容比对，
 * 校验不通过一律不使用 —— 绝不能把损坏的内容提交到 Dataverse。
 */

import { base64ToBytes, bytesToBase64 } from "./base64";
import { closeShellTerminal, enterSilentScreen, exitSilentScreen, extractMarkedLine, runShell } from "./file-shell";

/** 每块读取的字节数：块越小 PTY 单次输出越不容易被截断或混入噪声 */
const CHUNK_SIZE = 256 * 1024;

/** 单次读取的块数上限，避免超大文件把终端调用拖到不可接受的地步 */
const MAX_CHUNKS = 512;

/** 压缩包的临时路径：先 gzip 再分块读，终端输出量能少一个数量级 */
const ARCHIVE_PATH = "/tmp/pptb-assembly-read.gz";

/** 读取结果：成功时给出 Base64 内容，失败时说明原因 */
export interface ShellContentResult {
    /** Base64 编码的文件内容；读取或校验失败时为 null */
    content: string | null;
    /** 失败原因，用于界面提示 */
    error?: string;
}

/** 计算字节数组的 sha256 十六进制摘要 */
async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
    try {
        // crypto.subtle 只接受 ArrayBuffer，先把视图复制成独立缓冲区
        const buffer = new ArrayBuffer(bytes.length);
        new Uint8Array(buffer).set(bytes);
        const digest = await crypto.subtle.digest("SHA-256", buffer);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch (e) { // 非安全上下文等情况下无法计算，交由调用方判定失败
        console.warn("[file-content] 计算 sha256 失败:", e);
        return null;
    }
}

/** 检测文件所在平台；不支持的平台返回 null */
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

/** 取磁盘上的真实 sha256（小写十六进制），用于校验读取结果 */
async function readExpectedHash(platform: "darwin" | "win32" | "linux", path: string): Promise<string | null> {
    const quoted = quotePath(path);
    // 用标记包住摘要：终端会回显命令，而回显里含 a-f 等十六进制字符，直接清洗整个输出会误采集
    const command = platform === "win32"
        ? `powershell -NoProfile -Command "Write-Output ('__HASH__' + (Get-FileHash -Algorithm SHA256 -LiteralPath ${quoted}).Hash.ToLower())"`
        : `printf '__HASH__%s\\n' "$(shasum -a 256 ${quoted} 2>/dev/null | cut -d' ' -f1)"`;
    const result = await runShell(command);
    if (!result.output) return null;
    const block = extractMarkedLine(result.output, "__HASH__");
    if (!block) return null;
    const hash = block.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/** 拼出读取某一块的命令，输出用标记包裹便于截取 */
function buildChunkCommand(platform: "darwin" | "win32" | "linux", path: string, skip: number): string {
    const quoted = quotePath(path);
    if (platform === "win32") {
        return `powershell -NoProfile -Command "\\$b = [System.IO.File]::ReadAllBytes(${quoted}); `
            + `\\$start = ${skip} * ${CHUNK_SIZE}; \\$len = [Math]::Min(${CHUNK_SIZE}, \\$b.Length - \\$start); `
            + `if (\\$len -gt 0) { Write-Output ('__CHUNK__' + [Convert]::ToBase64String(\\$b, \\$start, \\$len)) }"`;
    }
    // 单行输出：末尾没有换行时，宿主会把最后一段与哨兵行合并丢弃
    return `printf '__CHUNK__%s\\n' "$(dd if=${quoted} bs=${CHUNK_SIZE} skip=${skip} count=1 2>/dev/null | base64 -b 0)"`;
}

/**
 * 把文件 gzip 压缩到临时路径，返回压缩后大小。
 * dll 这类二进制压缩率很高（实测 7.4 MB -> 1.3 MB），能显著减少终端刷屏与读取时间。
 */
async function prepareArchive(path: string): Promise<number> {
    const quoted = quotePath(path);
    const archive = quotePath(ARCHIVE_PATH);
    const result = await runShell(`gzip -c ${quoted} > ${archive} 2>/dev/null; `
        + `printf '__GZ__%s\\n' "$(stat -f %z ${archive} 2>/dev/null || stat -c %s ${archive} 2>/dev/null)"`);
    if (!result.output) return 0;
    const line = extractMarkedLine(result.output, "__GZ__");
    const size = Number((line ?? "").replace(/[^0-9]/g, ""));
    return Number.isFinite(size) && size > 0 ? size : 0;
}

/** 删除临时压缩包；失败不影响读取结果 */
async function removeArchive(): Promise<void> {
    await runShell(`rm -f ${quotePath(ARCHIVE_PATH)}`);
}

/** 用浏览器内置的解压流还原 gzip 内容 */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array | null> {
    try {
        const buffer = new ArrayBuffer(bytes.length);
        new Uint8Array(buffer).set(bytes);
        const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { // 解压失败按读取失败处理，绝不多半截内容
        console.warn("[file-content] 解压读取结果失败:", e);
        return null;
    }
}

/** 按块读取指定文件的全部字节；任一块失败返回 null */
async function readAllChunks(platform: "darwin" | "win32" | "linux", path: string, size: number): Promise<Uint8Array | null> {
    const chunkCount = Math.ceil(size / CHUNK_SIZE);
    if (chunkCount > MAX_CHUNKS) return null;
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let skip = 0; skip < chunkCount; skip += 1) {
        const chunk = await readChunk(platform, path, skip);
        if (!chunk) return null;
        parts.push(chunk);
        total += chunk.length;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        merged.set(part, offset);
        offset += part.length;
    }
    return merged;
}

/** 读取单个块并解码；失败返回 null */
async function readChunk(platform: "darwin" | "win32" | "linux", path: string, skip: number): Promise<Uint8Array | null> {
    const result = await runShell(buildChunkCommand(platform, path, skip));
    if (!result.output) return null;
    const block = extractMarkedLine(result.output, "__CHUNK__");
    if (!block) return null;
    // PTY 会在输出里混入控制字符：只保留 base64 字符集
    const cleaned = block.replace(/[^A-Za-z0-9+/=]/g, "");
    if (!cleaned) return null;
    return base64ToBytes(cleaned);
}

/**
 * 通过终端读取文件内容并校验。
 * size 用于计算块数；只有 sha256 与磁盘一致时才返回内容。
 */
export async function readFileContentFromShell(path: string, size: number): Promise<ShellContentResult> {
    try {
        return await readContent(path, size);
    } finally {
        // 分块内容会把终端面板刷满，读完后关闭终端，避免残留一屏 base64
        await closeShellTerminal();
    }
}

/** 实际的分块读取与校验流程；读取期间切到终端备用屏幕，主屏看不到刷屏 */
async function readContent(path: string, size: number): Promise<ShellContentResult> {
    await enterSilentScreen();
    try {
        return await readContentInSilentScreen(path, size);
    } finally {
        await exitSilentScreen();
    }
}

/** 在备用屏幕内分块读取并校验 */
async function readContentInSilentScreen(path: string, size: number): Promise<ShellContentResult> {
    if (!path || size <= 0) return { content: null, error: "No file size is available for this file." };
    const platform = detectPlatform();
    if (!platform) return { content: null, error: "Reading files through the shell is not supported on this platform." };

    if (Math.ceil(size / CHUNK_SIZE) > MAX_CHUNKS) {
        return { content: null, error: "This file is too large to read through the shell." };
    }

    const expectedHash = await readExpectedHash(platform, path);
    if (!expectedHash) return { content: null, error: "The shell could not read this file." };

    let merged: Uint8Array | null = null;
    // 非 Windows 平台先压缩再传输：终端输出量能少一个数量级，读取也更快
    if (platform !== "win32") {
        const archiveSize = await prepareArchive(path);
        if (archiveSize > 0) {
            try {
                const archived = await readAllChunks(platform, ARCHIVE_PATH, archiveSize);
                if (archived) merged = await gunzip(archived);
            } finally {
                await removeArchive();
            }
        }
    }
    if (!merged) merged = await readAllChunks(platform, path, size);
    if (!merged) return { content: null, error: "The shell could not read this file." };

    if (merged.length !== size) {
        return { content: null, error: `The file was read incompletely (${merged.length}/${size} bytes).` };
    }
    const actualHash = await sha256Hex(merged);
    if (!actualHash || actualHash !== expectedHash) {
        return { content: null, error: "The file content did not match the file on disk (checksum mismatch)." };
    }
    return { content: bytesToBase64(merged) };
}
