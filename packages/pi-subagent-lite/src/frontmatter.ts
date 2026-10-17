/**
 * 极简 YAML 子集解析：只覆盖代理档案 frontmatter 需要的写法。
 *
 * 支持：`key: value`、行内数组 `key: [a, b]`、块列表（`- item`）、块标量（`|` 保留换行 / `>` 折叠换行）、
 * 单双引号、`#` 行注释、布尔与数字字面量。**不支持嵌套映射**——遇到就抛错，让那个文件进
 * `/agents` 的「跳过 + 原因」列表，而不是猜。
 *
 * 为什么不引 YAML 库：本仓库的 `src/` 是不带依赖的纯层（pi 也不把 `yaml` 暴露给扩展），而档案
 * frontmatter 的形状是固定的几个字段。自己解析的边界更清楚，也更好单测。
 */
export interface FrontmatterDocument {
  data: Record<string, unknown>;
  body: string;
}

const FENCE = /^---\s*$/;

/** 切开 frontmatter 与正文；没有 frontmatter 时 `data` 为空对象、正文是全文。 */
export function parseFrontmatterDocument(text: string): FrontmatterDocument {
  const normalized = normalize(text);
  const lines = normalized.split("\n");
  if (!FENCE.test(lines[0] ?? "")) {
    return { data: {}, body: normalized.trim() };
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (FENCE.test(lines[index] ?? "")) {
      const raw = lines.slice(1, index).join("\n");
      const body = lines
        .slice(index + 1)
        .join("\n")
        .replace(/^\n+/, "")
        .trim();
      return { data: parseFrontmatterLines(raw), body };
    }
  }

  throw new Error("前置元数据缺少结束的 ---");
}

/** 只解析 frontmatter 文本本身（调用方已经切好）。 */
export function parseFrontmatterLines(raw: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = normalize(raw).split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    if (indentOf(line) > 0) {
      throw new Error(`第 ${index + 1} 行：不支持嵌套映射（缩进）`);
    }

    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) {
      throw new Error(`第 ${index + 1} 行不是 key: value 形式`);
    }
    const key = match[1] as string;
    const rest = match[2] ?? "";

    if (/^[|>][-+]?$/.test(rest)) {
      const block = readBlockScalar(lines, index + 1, rest.startsWith(">"));
      data[key] = block.value;
      index = block.next;
      continue;
    }
    if (rest === "") {
      const list = readBlockList(lines, index + 1);
      data[key] = list.value;
      index = list.next;
      continue;
    }

    data[key] = parseScalar(rest);
    index += 1;
  }

  return data;
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** 块标量：把后续缩进行收进来。`>` 折叠成空格，`|` 保留换行。 */
function readBlockScalar(
  lines: string[],
  start: number,
  fold: boolean,
): { value: string; next: number } {
  const collected: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      collected.push("");
      index += 1;
      continue;
    }
    if (indentOf(line) === 0) break;
    collected.push(line);
    index += 1;
  }

  const indent = Math.min(
    ...collected.filter((line) => line.trim() !== "").map((line) => indentOf(line)),
    Number.POSITIVE_INFINITY,
  );
  const stripped = collected.map((line) => (line.trim() === "" ? "" : line.slice(indent)));
  const value = fold ? stripped.join(" ").replace(/\s+/g, " ").trim() : stripped.join("\n").trim();
  return { value, next: index };
}

/** 块列表：`- item` 且缩进大于 0；空块返回 undefined（等价于没写这个字段）。 */
function readBlockList(lines: string[], start: number): { value: unknown; next: number } {
  const items: unknown[] = [];
  let index = start;
  let seen = false;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (indentOf(line) === 0) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      throw new Error(`第 ${index + 1} 行：块列表项必须以 "- " 开头`);
    }
    items.push(parseScalar(trimmed.slice(2)));
    seen = true;
    index += 1;
  }
  return { value: seen ? items : undefined, next: index };
}

/** 标量：引号、行内数组、布尔、null、数字，其余按原样字符串。 */
function parseScalar(raw: string): unknown {
  const text = stripComment(raw).trim();
  if (text === "") return undefined;
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\");
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    return splitInlineList(text.slice(1, -1)).map((item) => parseScalar(item));
  }
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** 去掉行尾 ` #` 注释（引号内的 `#` 不动）。 */
function stripComment(raw: string): string {
  let quote: string | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(raw[index - 1] ?? ""))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function splitInlineList(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of raw) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}
