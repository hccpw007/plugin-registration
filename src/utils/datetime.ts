/**
 * 时间显示的统一格式化：北京时间（UTC+8）yyyy-MM-dd HH:mm:ss。
 * Dataverse 与文件系统返回的时间都按 UTC 处理，这里固定换算到东八区，
 * 不跟随运行环境时区，保证同一份数据在任何机器上显示一致。
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
// .NET 序列化可能带 7 位小数，部分运行环境解析不了，截断到毫秒后再试
const EXTRA_FRACTION_PATTERN = /(\.\d{3})\d+/;

/** 把 UTC 时间字符串或时间戳解析成 Date；无法解析时返回 Invalid Date */
function toDate(value: string | number | Date): Date {
    if (value instanceof Date) return value;
    if (typeof value === "number") return new Date(value);
    const text = value.trim();
    if (!text) return new Date(Number.NaN);
    // 不带时区标记的字符串按 UTC 处理，避免被当成浏览器本地时间
    const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
    const parsed = new Date(withZone);
    return Number.isNaN(parsed.getTime())
        ? new Date(withZone.replace(EXTRA_FRACTION_PATTERN, "$1"))
        : parsed;
}

/** 格式化为北京时间 yyyy-MM-dd HH:mm:ss；空值或非法时间返回空串 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
    if (value === null || value === undefined || value === "") return "";
    const date = toDate(value);
    if (Number.isNaN(date.getTime())) return "";
    // 先整体平移 8 小时再用 UTC 取值，结果与运行环境时区无关
    const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ` +
        `${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
}
