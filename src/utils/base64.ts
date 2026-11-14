/** 单次拼接的字节块大小，避免 String.fromCharCode 参数过长导致调用栈溢出 */
const BASE64_CHUNK_SIZE = 0x8000;

/** 把字节数组编码为 Base64 */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
    }
    return btoa(binary);
}

/** 把 Base64 解码回字节数组；内容非法时返回 null */
export function base64ToBytes(base64: string): Uint8Array | null {
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    } catch { // 非法 base64（PTY 噪声导致）：交给调用方判定失败
        return null;
    }
}
