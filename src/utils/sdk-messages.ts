import type { SdkMessage } from "../models/interfaces";

/** 常用 SDK 消息（按使用频率排序），在消息下拉中置顶，减少滚动查找 */
const COMMON_MESSAGE_NAMES = [
    "Create",
    "Update",
    "Delete",
    "Retrieve",
    "RetrieveMultiple",
    "Associate",
    "Disassociate",
    "Assign",
    "SetState",
    "Merge",
    "CreateMultiple",
    "UpdateMultiple",
];

/**
 * 按使用频率排序消息：常用消息按预设顺序置顶，其余消息按名称升序。
 * 返回新数组，不修改调用方持有的原始消息列表（原列表仍用于按 ID 查找选中项）。
 */
export function sortMessagesByUsage(messages: SdkMessage[]): SdkMessage[] {
    // 未出现在常用清单中的消息统一排到末尾
    const priority = (name: string): number => {
        const index = COMMON_MESSAGE_NAMES.indexOf(name);
        return index === -1 ? COMMON_MESSAGE_NAMES.length : index;
    };

    return [...messages].sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name));
}
