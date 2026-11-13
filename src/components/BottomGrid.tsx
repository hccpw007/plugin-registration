import { useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import type { PluginType, ProcessingStep, StepImage } from "../models/interfaces";

interface BottomGridProps {
    mode: "plugins" | "steps" | "images" | "none";
    pluginTypes: PluginType[];
    steps: ProcessingStep[];
    images: StepImage[];
}

// 列定义：key 用于 React 列表键，defaultWidth 是该列首次显示时的像素宽度
interface ColumnDef {
    key: string;
    label: string;
    defaultWidth: number;
}

// 按表格模式分别保存的列宽，值为各列像素宽度
type ColumnWidthsByMode = Record<string, number[]>;

const STAGES: Record<number, string> = { 10: "Pre-Validation", 20: "Pre-Operation", 40: "Post-Operation" };
const MODES: Record<number, string> = { 0: "Synchronous", 1: "Asynchronous" };
const IMAGE_TYPES: Record<number, string> = { 0: "Pre Image", 1: "Post Image", 2: "Both" };

// 拖拽手柄的命中宽度需与 .bottom-table-col-resizer 的 width 保持一致
const RESIZE_HANDLE_WIDTH = 5;
// 列宽下限：再窄就无法辨认列标题，且容易误触相邻列
const MIN_COLUMN_WIDTH = 60;
// 列宽持久化键：加版本后缀，将来默认宽度调整时可整体失效旧数据
const COLUMN_WIDTH_STORAGE_KEY = "prt.bottomGrid.columnWidths.v1";

const PLUGIN_COLUMNS: ColumnDef[] = [
    { key: "friendlyname", label: "FriendlyName", defaultWidth: 240 },
    { key: "typename", label: "TypeName", defaultWidth: 420 },
    { key: "workflowactivitygroupname", label: "WorkflowActivityGroupName", defaultWidth: 220 },
    { key: "description", label: "Description", defaultWidth: 180 },
    { key: "modifiedon", label: "ModifiedOn", defaultWidth: 150 },
];

const STEP_COLUMNS: ColumnDef[] = [
    { key: "name", label: "Name", defaultWidth: 280 },
    { key: "message", label: "Message", defaultWidth: 170 },
    { key: "primaryentity", label: "Primary Entity", defaultWidth: 170 },
    { key: "stage", label: "Stage", defaultWidth: 130 },
    { key: "mode", label: "Mode", defaultWidth: 120 },
    { key: "rank", label: "Rank", defaultWidth: 80 },
    { key: "status", label: "Status", defaultWidth: 110 },
];

const IMAGE_COLUMNS: ColumnDef[] = [
    { key: "name", label: "Name", defaultWidth: 190 },
    { key: "entityalias", label: "Entity Alias", defaultWidth: 170 },
    { key: "imagetype", label: "Image Type", defaultWidth: 130 },
    { key: "messageproperty", label: "Message Property", defaultWidth: 190 },
    { key: "attributes", label: "Attributes", defaultWidth: 320 },
];

// 读取已保存的列宽；localStorage 不可用（隐私模式/配额）时降级为默认宽度，不阻断表格渲染
function loadColumnWidths(): ColumnWidthsByMode {
    try {
        const raw = localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY);
        if (!raw) {
            return {};
        }

        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as ColumnWidthsByMode) : {};
    } catch (error) {
        console.error("[BottomGrid] 读取列宽配置失败，回退默认列宽:", error);
        return {};
    }
}

// 写入某模式的列宽；先与已存内容合并——底部各表格是独立实例、各自持有 state，
// 直接覆盖会丢掉其他表格已保存的宽度。保存失败只影响下次打开时的记忆，不干扰当前拖拽。
function saveColumnWidths(modeKey: string, widths: number[]): void {
    try {
        const merged = { ...loadColumnWidths(), [modeKey]: widths };
        localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(merged));
    } catch (error) {
        console.error("[BottomGrid] 保存列宽配置失败:", error);
    }
}

// 取某模式的列宽，缺失或长度不符时按列定义补齐，避免列数变化后下标越界
function resolveWidths(widthsByMode: ColumnWidthsByMode, mode: string, columns: ColumnDef[]): number[] {
    const stored = widthsByMode[mode];
    return columns.map((column, index) => stored?.[index] ?? column.defaultWidth);
}

interface GridTableProps {
    columns: ColumnDef[];
    widths: number[];
    onResizeStart: (columnIndex: number, event: ReactMouseEvent<HTMLSpanElement>) => void;
    children: ReactNode;
}

// 底部表格统一外壳：负责表头、列宽手柄与横向滚动，行内容由调用方以 tbody 传入
function GridTable({ columns, widths, onResizeStart, children }: GridTableProps) {
    // 表格固定为各列宽度之和，配合 table-layout: fixed 让列宽严格等于用户拖出的值
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);

    return (
        // 列宽是用户拖拽产生的动态值，无法用样式类表达，此处必须内联
        <table className="bottom-table" style={{ width: `${totalWidth}px` }}>
            <colgroup>
                {widths.map((width, index) => (
                    <col key={columns[index].key} style={{ width: `${width}px` }} />
                ))}
            </colgroup>
            <thead>
                <tr>
                    {columns.map((column, index) => (
                        <th key={column.key}>
                            {column.label}
                            {/* 拖拽手柄：按住左右拖动调整当前列宽度 */}
                            <span
                                className="bottom-table-col-resizer"
                                role="separator"
                                aria-orientation="vertical"
                                title="拖动调整列宽"
                                onMouseDown={(event) => onResizeStart(index, event)}
                            />
                        </th>
                    ))}
                </tr>
            </thead>
            {children}
        </table>
    );
}

export function BottomGrid({ mode, pluginTypes, steps, images }: BottomGridProps) {
    const [widthsByMode, setWidthsByMode] = useState<ColumnWidthsByMode>(loadColumnWidths);
    // 拖拽结束后要写入最新宽度，用 ref 避开闭包里的过期 state
    const widthsRef = useRef(widthsByMode);
    widthsRef.current = widthsByMode;

    // 开始拖拽：把移动与松开监听挂到 window，鼠标移出表格范围也不会中断
    const startResize = (
        modeKey: string,
        columns: ColumnDef[],
        columnIndex: number,
        event: ReactMouseEvent<HTMLSpanElement>
    ) => {
        // 阻止默认行为，避免拖动时选中表头文字
        event.preventDefault();

        const startX = event.clientX;
        const startWidth = resolveWidths(widthsRef.current, modeKey, columns)[columnIndex];
        // 记录本次拖拽最后一次算出的列宽：mouseup 时组件尚未重渲染，只能靠它拿到最新值
        let latestWidths: number[] | null = null;

        const handleMove = (moveEvent: MouseEvent) => {
            // 减去手柄半宽，让指针停在分隔线正中时宽度变化最自然
            const delta = moveEvent.clientX - startX - Math.floor(RESIZE_HANDLE_WIDTH / 2);
            const nextWidth = Math.max(MIN_COLUMN_WIDTH, startWidth + delta);

            setWidthsByMode((previous) => {
                const current = resolveWidths(previous, modeKey, columns);
                const next = current.map((width, index) => (index === columnIndex ? nextWidth : width));
                latestWidths = next;
                return { ...previous, [modeKey]: next };
            });
        };

        const handleUp = () => {
            window.removeEventListener("mousemove", handleMove);
            window.removeEventListener("mouseup", handleUp);

            // 拖拽结束才落盘，避免拖动过程中高频写 localStorage
            if (latestWidths) {
                saveColumnWidths(modeKey, latestWidths);
            }
        };

        window.addEventListener("mousemove", handleMove);
        window.addEventListener("mouseup", handleUp);
    };

    if (mode === "none") {
        return <div className="bottom-empty">Select an item in the tree to see details.</div>;
    }

    if (mode === "plugins") {
        return (
            <GridTable
                columns={PLUGIN_COLUMNS}
                widths={resolveWidths(widthsByMode, "plugins", PLUGIN_COLUMNS)}
                onResizeStart={(index, event) => startResize("plugins", PLUGIN_COLUMNS, index, event)}
            >
                <tbody>
                    {pluginTypes.length === 0 ? (
                        <tr><td colSpan={5} className="bottom-empty-cell">No plugin types found.</td></tr>
                    ) : pluginTypes.map((pt) => (
                        <tr key={pt.plugintypeid}>
                            <td>{pt.friendlyname || "—"}</td>
                            <td>{pt.typename}</td>
                            <td>{pt.workflowactivitygroupname || "—"}</td>
                            <td>{pt.description || "—"}</td>
                            <td>{pt.modifiedon || "—"}</td>
                        </tr>
                    ))}
                </tbody>
            </GridTable>
        );
    }

    if (mode === "steps") {
        return (
            <GridTable
                columns={STEP_COLUMNS}
                widths={resolveWidths(widthsByMode, "steps", STEP_COLUMNS)}
                onResizeStart={(index, event) => startResize("steps", STEP_COLUMNS, index, event)}
            >
                <tbody>
                    {steps.length === 0 ? (
                        <tr><td colSpan={7} className="bottom-empty-cell">No steps registered.</td></tr>
                    ) : steps.map((s) => (
                        <tr key={s.sdkmessageprocessingstepid}>
                            <td>{s.name}</td>
                            <td>{s.messageName}</td>
                            <td>{s.primaryEntityName || "none"}</td>
                            <td>{STAGES[s.stage] ?? s.stage}</td>
                            <td>{MODES[s.mode] ?? s.mode}</td>
                            <td>{s.rank}</td>
                            <td>
                                <span className={`badge ${s.statecode === 0 ? "badge-success" : "badge-danger"}`}>
                                    {s.statecode === 0 ? "Enabled" : "Disabled"}
                                </span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </GridTable>
        );
    }

    if (mode === "images") {
        return (
            <GridTable
                columns={IMAGE_COLUMNS}
                widths={resolveWidths(widthsByMode, "images", IMAGE_COLUMNS)}
                onResizeStart={(index, event) => startResize("images", IMAGE_COLUMNS, index, event)}
            >
                <tbody>
                    {images.length === 0 ? (
                        <tr><td colSpan={5} className="bottom-empty-cell">No images registered.</td></tr>
                    ) : images.map((img) => (
                        <tr key={img.sdkmessageprocessingstepimageid}>
                            <td>{img.name}</td>
                            <td>{img.entityalias}</td>
                            <td>{IMAGE_TYPES[img.imagetype] ?? img.imagetype}</td>
                            <td>{img.messagepropertyname}</td>
                            <td>{img.attributes || <em>All</em>}</td>
                        </tr>
                    ))}
                </tbody>
            </GridTable>
        );
    }

    return null;
}
