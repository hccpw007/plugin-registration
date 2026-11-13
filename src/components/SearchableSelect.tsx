import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

/** 可搜索下拉的单个候选项 */
export interface SearchableSelectOption {
    value: string;
    label: string;
}

interface SearchableSelectProps {
    value: string;
    options: SearchableSelectOption[];
    onChange: (value: string) => void;
    /** 未选中任何候选项时输入框内显示的提示文案 */
    placeholder: string;
    /** 输入内容没有匹配候选项时列表内显示的提示文案 */
    emptyText?: string;
    disabled?: boolean;
}

/**
 * 可输入筛选的下拉选择框，用于替代选项可能多达数百条的原生 `<select>`。
 * 原生下拉无法输入过滤，且选项过多时会铺满整屏；此处改为输入框 + 限高可滚动的候选列表。
 */
export function SearchableSelect({
    value,
    options,
    onChange,
    placeholder,
    emptyText = "No matches",
    disabled = false,
}: SearchableSelectProps) {
    // 展开时输入框进入筛选模式，收起时展示当前选中项的标签
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    // 键盘方向键高亮项的下标，-1 表示未高亮任何项
    const [activeIndex, setActiveIndex] = useState(-1);
    const listRef = useRef<HTMLUListElement>(null);

    const selectedLabel = options.find((option) => option.value === value)?.label ?? "";
    const normalizedQuery = query.trim().toLowerCase();
    // 有输入时按标签做不区分大小写的包含匹配，无输入时展示全部候选项
    const filteredOptions = normalizedQuery
        ? options.filter((option) => option.label.toLowerCase().includes(normalizedQuery))
        : options;

    // 选中值被外部改动（如切换消息后重置主实体）时收起下拉，避免列表与当前值不一致
    useEffect(() => {
        setOpen(false);
        setQuery("");
        setActiveIndex(-1);
    }, [value]);

    // 方向键移动高亮项时滚动到可见区域（列表本身限高）
    useEffect(() => {
        const activeItem = listRef.current?.children[activeIndex] as HTMLElement | undefined;
        activeItem?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    const openList = () => {
        if (disabled) return;
        setOpen(true);
        // 聚焦时清空输入，让用户从完整候选列表开始筛选
        setQuery("");
        setActiveIndex(-1);
    };

    const closeList = () => {
        setOpen(false);
        setQuery("");
        setActiveIndex(-1);
    };

    const selectOption = (option: SearchableSelectOption) => {
        onChange(option.value);
        closeList();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        // Esc 收起下拉并放弃本次筛选
        if (event.key === "Escape") {
            closeList();
            return;
        }
        // 上下方向键在候选项之间循环移动高亮项
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
                openList();
                return;
            }
            if (filteredOptions.length === 0) return;
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((current) => (current + delta + filteredOptions.length) % filteredOptions.length);
            return;
        }
        // Enter 选中当前高亮项
        if (event.key === "Enter" && open) {
            const highlighted = filteredOptions[activeIndex];
            if (highlighted) {
                event.preventDefault();
                selectOption(highlighted);
            }
        }
    };

    return (
        <div className="searchable-select">
            {/* 输入框：展开时显示筛选关键字，收起时显示当前选中项 */}
            <input
                type="text"
                className="form-input"
                value={open ? query : selectedLabel}
                placeholder={placeholder}
                disabled={disabled}
                onFocus={openList}
                onChange={(event) => {
                    setQuery(event.target.value);
                    setOpen(true);
                    // 输入后默认高亮第一个匹配项，便于直接按 Enter 选中
                    setActiveIndex(event.target.value.trim() ? 0 : -1);
                }}
                onBlur={closeList}
                onKeyDown={handleKeyDown}
                role="combobox"
                aria-expanded={open}
                aria-autocomplete="list"
            />
            {/* 候选项列表：限高可滚动，点击即选中 */}
            {open && (
                <ul className="searchable-select-list" role="listbox" ref={listRef}>
                    {filteredOptions.length === 0 ? (
                        <li className="searchable-select-empty">{emptyText}</li>
                    ) : (
                        filteredOptions.map((option, index) => (
                            <li
                                key={option.value}
                                className={`searchable-select-option${index === activeIndex ? " active" : ""}${option.value === value ? " selected" : ""}`}
                                role="option"
                                aria-selected={option.value === value}
                                // 阻止 mousedown 抢占焦点，否则输入框先失焦导致下拉关闭、点击丢失
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => setActiveIndex(index)}
                                onClick={() => selectOption(option)}
                            >
                                {option.label}
                            </li>
                        ))
                    )}
                </ul>
            )}
        </div>
    );
}
