/**
 * 从程序集字节中提取「可注册为 plugintype」的类型清单。
 *
 * 判定规则与 XrmToolBox 的 PRT 一致（AssemblyReader.RetrievePluginsFromAssembly）：
 * 类型必须是 public、非抽象类，且实现 IPlugin / ICrmPlugin（v4）或继承 CodeActivity / Activity。
 * 插件类通常继承自己的基类间接实现 IPlugin，因此必须沿 extends 链递归查找，
 * 只匹配直接实现接口会漏掉绝大多数实际存在的插件。
 */
import { readMetadataImage, type MetadataImage } from "./pe-metadata";

/** 可注册类型的判定结果 */
export interface AssemblyTypeInfo {
  /** 类型全名，写入 plugintype.typename 与 name */
  fullName: string;
  /** 是否 Workflow Activity（继承 CodeActivity / Activity） */
  isWorkflowActivity: boolean;
}

const PLUGIN_INTERFACE_NAMES = new Set(["Microsoft.Xrm.Sdk.IPlugin", "Microsoft.Crm.Sdk.IPlugin"]);
const ACTIVITY_BASE_NAMES = new Set(["System.Activities.CodeActivity", "System.Activities.Activity"]);
const TYPE_DEF_OR_REF_TAG_BITS = 2;
const MAX_INHERITANCE_DEPTH = 16;
const PUBLIC_VISIBILITY_MASK = 0x00000007;
const PUBLIC_VISIBILITY = 0x00000001;
const ABSTRACT_FLAG = 0x00000080;

/** 程序集内的类型引用；kind 区分本地 TypeDef 与外部 TypeRef */
interface TypeReference {
  kind: "def" | "ref" | "spec";
  index: number;
}

function decodeTypeDefOrRef(coded: number): TypeReference {
  const tag = coded & ((1 << TYPE_DEF_OR_REF_TAG_BITS) - 1);
  const index = coded >> TYPE_DEF_OR_REF_TAG_BITS;
  if (tag === 0) return { kind: "def", index };
  if (tag === 1) return { kind: "ref", index };
  return { kind: "spec", index };
}

function fullNameOf(image: MetadataImage, nameIndex: number, namespaceIndex: number): string {
  const typeName = image.readString(nameIndex);
  const namespace = image.readString(namespaceIndex);
  return namespace ? `${namespace}.${typeName}` : typeName;
}

/** 汇总每个 TypeDef 直接实现的接口全名，键为 0 基行号 */
function buildInterfaceMap(image: MetadataImage): Map<number, string[]> {
  const result = new Map<number, string[]>();
  for (const row of image.interfaceImpls) {
    const ownerIndex = row.classIndex - 1;
    if (ownerIndex < 0) continue;
    const reference = decodeTypeDefOrRef(row.interface);
    const names = result.get(ownerIndex) ?? [];
    // TypeSpec 是泛型实例化，无法还原成稳定类型名，忽略即可（插件接口不会是泛型）
    if (reference.kind === "ref") {
      const target = image.typeRefs[reference.index - 1];
      if (target) names.push(fullNameOf(image, target.nameIndex, target.namespaceIndex));
    } else if (reference.kind === "def") {
      const target = image.typeDefs[reference.index - 1];
      if (target) names.push(fullNameOf(image, target.nameIndex, target.namespaceIndex));
    }
    result.set(ownerIndex, names);
  }
  return result;
}

/**
 * 沿继承链判断类型是插件还是工作流活动。
 * @param typeIndex TypeDef 的 0 基行号
 */
function resolveTypeKind(
  image: MetadataImage,
  interfaces: Map<number, string[]>,
  typeIndex: number,
  visited: Set<number>,
  depth = 0,
): { isPlugin: boolean; isActivity: boolean } {
  if (typeIndex < 0 || typeIndex >= image.typeDefs.length) return { isPlugin: false, isActivity: false };
  if (depth > MAX_INHERITANCE_DEPTH || visited.has(typeIndex)) {
    return { isPlugin: false, isActivity: false };
  }
  visited.add(typeIndex);

  const directInterfaces = interfaces.get(typeIndex) ?? [];
  const isPlugin = directInterfaces.some((name) => PLUGIN_INTERFACE_NAMES.has(name));

  const extendsCoded = image.typeDefs[typeIndex]!.extends;
  if (!extendsCoded) return { isPlugin, isActivity: false };

  const base = decodeTypeDefOrRef(extendsCoded);
  const baseName =
    base.kind === "ref"
      ? (() => {
          const target = image.typeRefs[base.index - 1];
          return target ? fullNameOf(image, target.nameIndex, target.namespaceIndex) : "";
        })()
      : base.kind === "def"
        ? (() => {
            const target = image.typeDefs[base.index - 1];
            return target ? fullNameOf(image, target.nameIndex, target.namespaceIndex) : "";
          })()
        : "";

  // 基类名命中最外层 SDK 基类即判定为活动；此时无需继续向上，链外类型无法再提供证据
  if (ACTIVITY_BASE_NAMES.has(baseName)) return { isPlugin, isActivity: true };

  if (base.kind !== "def") return { isPlugin, isActivity: false };

  const parent = resolveTypeKind(image, interfaces, base.index - 1, visited, depth + 1);
  return { isPlugin: isPlugin || parent.isPlugin, isActivity: parent.isActivity };
}

/** base64 转字节；逐字节写入比 Uint8Array.from 快，7MB 级程序集不会卡住渲染线程 */
function base64ToBytes(base64Content: string): Uint8Array {
  const binary = atob(base64Content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 解析程序集内容并返回可注册类型清单（按类型名排序，便于结果稳定比对）。
 * @param base64Content DLL 的 base64 内容
 * @throws 程序集不是有效 PE 镜像或元数据损坏时抛出
 */
export function extractRegistrableTypes(base64Content: string): AssemblyTypeInfo[] {
  const image = readMetadataImage(base64ToBytes(base64Content));
  const interfaces = buildInterfaceMap(image);
  const result: AssemblyTypeInfo[] = [];

  // 行 0 是 <Module> 伪类型，从 1 开始
  for (let typeIndex = 1; typeIndex < image.typeDefs.length; typeIndex++) {
    const typeDef = image.typeDefs[typeIndex]!;
    const visibility = typeDef.flags & PUBLIC_VISIBILITY_MASK;
    if (visibility !== PUBLIC_VISIBILITY) continue;
    if ((typeDef.flags & ABSTRACT_FLAG) !== 0) continue;

    const kind = resolveTypeKind(image, interfaces, typeIndex, new Set<number>());
    if (!kind.isPlugin && !kind.isActivity) continue;

    result.push({
      fullName: fullNameOf(image, typeDef.nameIndex, typeDef.namespaceIndex),
      isWorkflowActivity: !kind.isPlugin && kind.isActivity,
    });
  }

  return result.sort((left, right) => left.fullName.localeCompare(right.fullName));
}
