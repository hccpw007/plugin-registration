/**
 * PE / CLI 元数据读取（ECMA-335）。
 *
 * 只解析提取插件类型所需的表 0-9，不实现完整元数据表清单：
 * 表按序号顺序存放，定位 TypeDef / InterfaceImpl 只需知道前面这些表的行宽即可。
 *
 * 已知局限：不解析 NestedClass 表，因此嵌套类型无法还原成 `Outer+Inner` 全名。
 * 插件类几乎都是顶层类型，遇到嵌套类型时平台会拒绝创建并回报错误，不会污染既有数据。
 */

/** PE 节表项，用于把 RVA 换算成文件偏移 */
interface PeSection {
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawPointer: number;
}

/** TypeDef 行：只保留判断可见性与继承链所需的列 */
export interface TypeDefRow {
  flags: number;
  nameIndex: number;
  namespaceIndex: number;
  extends: number;
}

/** TypeRef 行：用于解析外部基类与接口名 */
export interface TypeRefRow {
  nameIndex: number;
  namespaceIndex: number;
}

/** InterfaceImpl 行：Class 是 TypeDef 的一基索引，Interface 是 TypeDefOrRef 编码值 */
export interface InterfaceImplRow {
  classIndex: number;
  interface: number;
}

/** 解析结果：表行数据 + 字符串堆读取器 */
export interface MetadataImage {
  typeDefs: TypeDefRow[];
  typeRefs: TypeRefRow[];
  interfaceImpls: InterfaceImplRow[];
  readString(index: number): string;
}

const PE_SIGNATURE = 0x00004550;
const CLI_HEADER_DIRECTORY_INDEX = 14;
const METADATA_SIGNATURE = 0x424a5342;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const PE32_OPTIONAL_HEADER_SIZE = 96;
const PE32_PLUS_OPTIONAL_HEADER_SIZE = 112;
const SECTION_HEADER_SIZE = 40;
const STRING_INDEX_4BYTE = 0x01;
const GUID_INDEX_4BYTE = 0x02;
const BLOB_INDEX_4BYTE = 0x04;
const TABLE_COUNT = 10;

/**
 * 表列定义。"s"/"g"/"b" 为堆索引，"t:N" 为表 N 的简单索引，"c:X" 为编码索引。
 * 列顺序必须与 ECMA-335 一致，行宽依赖它计算。
 */
const TABLE_SCHEMAS: readonly (readonly string[])[] = [
  ["u2", "s", "g", "g", "g"], // 0 Module
  ["c:resolutionScope", "s", "s"], // 1 TypeRef
  ["u4", "s", "s", "c:typeDefOrRef", "t:4", "t:6"], // 2 TypeDef
  ["t:4"], // 3 FieldPtr
  ["u2", "s", "b"], // 4 Field
  ["t:6"], // 5 MethodPtr
  ["u4", "u2", "u2", "s", "b", "t:8"], // 6 MethodDef
  ["t:8"], // 7 ParamPtr
  ["u2", "u2", "s"], // 8 Param
  ["t:2", "c:typeDefOrRef"], // 9 InterfaceImpl
];

/** 编码索引：低 tagBits 位是表标记，其余位是表内的一基索引 */
const CODED_INDEXES: Record<string, { tagBits: number; tables: number[] }> = {
  typeDefOrRef: { tagBits: 2, tables: [2, 1, 0x1b] },
  resolutionScope: { tagBits: 2, tables: [0, 0x1a, 0x23, 1] },
};

/** 有符号边界检查的字节读取器，越界即抛错，避免读到无效偏移后静默产出错误类型名 */
class ByteReader {
  private readonly view: DataView;
  position: number;

  constructor(bytes: Uint8Array, position = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.position = position;
  }

  u8(): number {
    const value = this.view.getUint8(this.position);
    this.position += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.position, true);
    this.position += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  u64(): bigint {
    const value = this.view.getBigUint64(this.position, true);
    this.position += 8;
    return value;
  }

  skip(count: number): void {
    this.position += count;
  }

  /** 读取以 NUL 结尾的 ASCII 名称，返回名称与其结束位置（不含 NUL） */
  asciiZ(maxLength: number): string {
    const start = this.position;
    const end = start + maxLength;
    const decoder = new TextDecoder();
    for (let i = start; i < end; i++) {
      if (this.view.getUint8(i) === 0) {
        this.position = i + 1;
        return decoder.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + start, i - start));
      }
    }
    throw new Error("PE 名称字段未以 NUL 结尾");
  }
}

/** 把 RVA 换算成文件偏移；未落在任何节内说明镜像损坏 */
function rvaToOffset(sections: readonly PeSection[], rva: number): number {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return section.rawPointer + (rva - section.virtualAddress);
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} 未映射到任何节`);
}

interface PeLayout {
  sections: PeSection[];
  cliHeaderRva: number;
}

/** 解析 PE 头，定位节表与 CLI 头目录项 */
function readPeLayout(reader: ByteReader): PeLayout {
  reader.position = 0x3c;
  const peOffset = reader.u32();
  reader.position = peOffset;
  if (reader.u32() !== PE_SIGNATURE) throw new Error("文件不是有效的 PE 镜像");

  reader.u16(); // Machine
  const sectionCount = reader.u16();
  reader.skip(12); // TimeDateStamp / PointerToSymbolTable / NumberOfSymbols
  const optionalHeaderSize = reader.u16();
  reader.skip(2); // Characteristics

  const optionalHeaderOffset = peOffset + 24;
  reader.position = optionalHeaderOffset;
  const magic = reader.u16();
  const dataDirectoryOffset =
    optionalHeaderOffset + (magic === PE32_PLUS_MAGIC ? PE32_PLUS_OPTIONAL_HEADER_SIZE : PE32_OPTIONAL_HEADER_SIZE);
  if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) {
    throw new Error(`不支持的 Optional Header 类型 0x${magic.toString(16)}`);
  }

  reader.position = dataDirectoryOffset + CLI_HEADER_DIRECTORY_INDEX * 8;
  const cliHeaderRva = reader.u32();

  const sections: PeSection[] = [];
  reader.position = optionalHeaderOffset + optionalHeaderSize;
  // 逐个读节表：RVA 换算依赖它，缺一节就会算错元数据位置
  for (let i = 0; i < sectionCount; i++) {
    reader.skip(8); // Name
    const virtualSize = reader.u32();
    const virtualAddress = reader.u32();
    const rawSize = reader.u32();
    const rawPointer = reader.u32();
    sections.push({ virtualAddress, virtualSize, rawSize, rawPointer });
    reader.skip(SECTION_HEADER_SIZE - 24); // 跳过其余节属性
  }

  return { sections, cliHeaderRva };
}

/** 定位元数据根（"BSJB"）的文件偏移 */
function findMetadataRoot(bytes: Uint8Array, layout: PeLayout): number {
  const cliOffset = rvaToOffset(layout.sections, layout.cliHeaderRva);
  const cliReader = new ByteReader(bytes, cliOffset + 8);
  const metadataRva = cliReader.u32();
  const metadataOffset = rvaToOffset(layout.sections, metadataRva);
  const signatureView = new DataView(bytes.buffer, bytes.byteOffset + metadataOffset, 4);
  if (signatureView.getUint32(0, true) !== METADATA_SIGNATURE) {
    throw new Error("元数据根签名无效");
  }
  return metadataOffset;
}

interface StreamRange {
  offset: number;
  size: number;
}

/** 读取元数据根的流目录，返回各流的文件区间 */
function readStreamRanges(bytes: Uint8Array, metadataOffset: number): Map<string, StreamRange> {
  const reader = new ByteReader(bytes, metadataOffset + 4);
  reader.skip(4); // MajorVersion / MinorVersion
  reader.skip(4); // Reserved
  const versionLength = reader.u32();
  reader.skip(versionLength);
  reader.skip(2); // Flags
  const streamCount = reader.u16();

  const ranges = new Map<string, StreamRange>();
  const decoder = new TextDecoder();
  // 流名称按 4 字节对齐存放，含结尾 NUL；对齐错误会让后续所有流的偏移失准
  for (let i = 0; i < streamCount; i++) {
    const offset = reader.u32();
    const size = reader.u32();
    const nameStart = reader.position;
    const nameBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + nameStart);
    let nameLength = 0;
    while (nameBytes[nameLength] !== 0) nameLength += 1;
    const name = decoder.decode(nameBytes.subarray(0, nameLength));
    const paddedLength = Math.ceil((nameLength + 1) / 4) * 4;
    reader.position = nameStart + paddedLength;
    if (!ranges.has(name)) ranges.set(name, { offset: metadataOffset + offset, size });
  }

  return ranges;
}

interface TablesStream {
  heapSizes: number;
  rowCounts: number[];
}

/** 读取 #~ 表流的头部与各表行数 */
function readTablesHeader(reader: ByteReader): TablesStream {
  reader.skip(4); // Reserved
  reader.u8(); // MajorVersion
  reader.u8(); // MinorVersion
  const heapSizes = reader.u8();
  reader.u8(); // Reserved
  const valid = reader.u64();
  reader.u64(); // Sorted

  const rowCounts: number[] = new Array<number>(64).fill(0);
  // 只有 valid 位图中的表才在头部出现行数，缺位表按 0 行处理
  for (let table = 0; table < 64; table++) {
    if (((valid >> BigInt(table)) & 1n) === 1n) rowCounts[table] = reader.u32();
  }
  return { heapSizes, rowCounts };
}

/** 计算单列字节宽度；表行宽与列偏移都依赖它 */
function columnSize(column: string, stream: TablesStream): number {
  if (column === "u2") return 2;
  if (column === "u4") return 4;
  if (column === "s") return (stream.heapSizes & STRING_INDEX_4BYTE) !== 0 ? 4 : 2;
  if (column === "g") return (stream.heapSizes & GUID_INDEX_4BYTE) !== 0 ? 4 : 2;
  if (column === "b") return (stream.heapSizes & BLOB_INDEX_4BYTE) !== 0 ? 4 : 2;

  if (column.startsWith("t:")) {
    const table = Number.parseInt(column.slice(2), 10);
    return (stream.rowCounts[table] ?? 0) < 0x10000 ? 2 : 4;
  }

  const coded = CODED_INDEXES[column.slice(2)];
  if (!coded) throw new Error(`未知的元数据列定义 ${column}`);
  const maxRows = Math.max(...coded.tables.map((table) => stream.rowCounts[table] ?? 0));
  return maxRows < 2 ** (16 - coded.tagBits) ? 2 : 4;
}

/** 按需读取某个表某一行的某一列 */
function createRowReader(bytes: Uint8Array, tableOffsets: number[], stream: TablesStream) {
  const rowWidths = TABLE_SCHEMAS.map((schema) =>
    schema.reduce((total, column) => total + columnSize(column, stream), 0),
  );

  return (table: number, row: number, column: number): number => {
    const schema = TABLE_SCHEMAS[table]!;
    let offset = tableOffsets[table]! + row * rowWidths[table]!;
    for (let i = 0; i < column; i++) offset += columnSize(schema[i]!, stream);
    const width = columnSize(schema[column]!, stream);
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, width);
    return width === 2 ? view.getUint16(0, true) : view.getUint32(0, true);
  };
}

/**
 * 解析程序集字节，返回提取插件类型所需的元数据表。
 * @param bytes PE 镜像字节
 */
export function readMetadataImage(bytes: Uint8Array): MetadataImage {
  const layoutReader = new ByteReader(bytes);
  const layout = readPeLayout(layoutReader);
  const metadataOffset = findMetadataRoot(bytes, layout);
  const streams = readStreamRanges(bytes, metadataOffset);

  const tablesRange = streams.get("#~") ?? streams.get("#-");
  if (!tablesRange) throw new Error("元数据缺少表流（#~）");

  const headerReader = new ByteReader(bytes, tablesRange.offset);
  const stream = readTablesHeader(headerReader);

  // 表起始位置必须顺序累加：表未按物理顺序存放时，逐表加行宽即可得到下一表起点
  const tableOffsets: number[] = [];
  let cursor = headerReader.position;
  for (let table = 0; table < TABLE_COUNT; table++) {
    tableOffsets[table] = cursor;
    const rowCount = stream.rowCounts[table] ?? 0;
    if (rowCount === 0) continue;
    const rowWidth = TABLE_SCHEMAS[table]!.reduce(
      (total, column) => total + columnSize(column, stream),
      0,
    );
    cursor += rowWidth * rowCount;
  }
  const readTable = createRowReader(bytes, tableOffsets, stream);

  const stringsRange = streams.get("#Strings");
  const decoder = new TextDecoder();
  const readString = (index: number): string => {
    if (!stringsRange) return "";
    const start = stringsRange.offset + index;
    const limit = stringsRange.offset + stringsRange.size;
    let end = start;
    while (end < limit && bytes[end] !== 0) end += 1;
    return decoder.decode(bytes.subarray(start, end));
  };

  const typeDefs: TypeDefRow[] = [];
  // 行 0 是 <Module> 伪类型，仍需保留以维持一基索引对齐
  for (let row = 0; row < (stream.rowCounts[2] ?? 0); row++) {
    typeDefs.push({
      flags: readTable(2, row, 0),
      nameIndex: readTable(2, row, 1),
      namespaceIndex: readTable(2, row, 2),
      extends: readTable(2, row, 3),
    });
  }

  const typeRefs: TypeRefRow[] = [];
  for (let row = 0; row < (stream.rowCounts[1] ?? 0); row++) {
    typeRefs.push({ nameIndex: readTable(1, row, 1), namespaceIndex: readTable(1, row, 2) });
  }

  const interfaceImpls: InterfaceImplRow[] = [];
  for (let row = 0; row < (stream.rowCounts[9] ?? 0); row++) {
    interfaceImpls.push({ classIndex: readTable(9, row, 0), interface: readTable(9, row, 1) });
  }

  return { typeDefs, typeRefs, interfaceImpls, readString };
}
