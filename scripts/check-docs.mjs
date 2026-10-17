#!/usr/bin/env node
/**
 * 文档交叉引用检查。
 *
 * 本仓库的开发文档留在本机、不进仓库，所以"改了编号、别处引用过期"很难被发现。
 * 这个脚本替人盯着四件事：
 *   1. 设计文档与 ADR 里的 markdown 链接指向的文件真的存在
 *   2. `通配 NN` 指到的票据文件存在（并且确实是一张票）
 *   3. 每张票的 `Blocked by:` 里的编号都有对应的票
 *   4. `spec.md` 里引用的路径存在
 *
 * 两条实现约定（本机工作树是 CRLF，踩过假报错的坑）：
 *   - 所有文本先归一化 `\r` 再匹配
 *   - 只把形如 `*.md` 的真实路径当路径，`docs/adr/0001..0007` 这类范围写法跳过
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.argv[2] ?? process.cwd());
const ISSUE_DIR = join(ROOT, ".scratch/pi-extension-suite/issues");
const SPEC_PATH = join(ROOT, ".scratch/pi-extension-suite/spec.md");
const ISSUE_NUM = /^(\d{2})-/;

/** 归一化 CRLF（以及裸 CR），让正则不必关心行尾。 */
export function normalize(text) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * 从 markdown 文本里抽出"看起来是仓库内文件路径"的引用。
 *
 * 只认这两种写法：
 *   - markdown 链接 `[text](target)`
 *   - 行内代码里以 `.md` 结尾、不含通配符的路径
 *
 * 刻意不认 `docs/adr/0001..0007` 这种范围写法，也不认 URL。
 */
export function extractRefs(text) {
  const normalized = normalize(text);
  const refs = [];
  const lines = normalized.split("\n");

  lines.forEach((line, index) => {
    // markdown 链接
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (target.startsWith("http://") || target.startsWith("https://")) continue;
      if (target.startsWith("#")) continue;
      const path = target.split("#")[0].split("?")[0];
      if (!isPathLike(path)) continue;
      refs.push({ path, line: index + 1 });
    }

    // 行内代码里的路径（spec 与票大量使用）
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const candidate = match[1].trim();
      if (!looksLikeRepoPath(candidate)) continue;
      refs.push({ path: candidate, line: index + 1 });
    }
  });

  return refs;
}

/** 链接目标里的路径：必须是带扩展名的相对路径，且不含范围写法。 */
function isPathLike(target) {
  if (!target.includes(".")) return false;
  if (target.includes("..")) return false;
  if (/[*?]/.test(target)) return false;
  return isRelativeRepoPath(target);
}

/**
 * 行内代码里的路径。要求以 `.md` 结尾——这是最保守的判据：
 * 设计文档与票引用的"文件"几乎都是 markdown，误判成本直接归零。
 */
function looksLikeRepoPath(candidate) {
  if (!candidate.endsWith(".md")) return false;
  if (/[*?{}]/.test(candidate)) return false;
  return isRelativeRepoPath(candidate);
}

/**
 * 只认**本仓库自己的**文档路径。
 *
 * 排除掉两类会假报错的写法：
 *   - 花括号展开（`docs/{extensions,compaction}.md`）——那是描述一组 pi 文档的简写
 *   - pi 自己的文档（`docs/extensions.md`、`docs/compaction.md` …）——它们是外部锚点，
 *     不在本仓库里；本仓库的文档在 `docs/design/`、`docs/adr/`、`docs/agents/` 下
 */
const OWN_DOC_DIRS = ["docs/design/", "docs/adr/", "docs/agents/"];
const OWN_DOC_FILES = new Set([
  "GLOSSARY.md",
  "AGENTS.md",
  "CODING_STANDARDS.md",
  "docs/pi-contract-map.md",
]);

function isRelativeRepoPath(candidate) {
  if (candidate.startsWith("/") || candidate.startsWith("~")) return false;
  if (candidate.startsWith("#")) return false;
  // `E:\...` / `C:/...` 这类本机绝对路径不算
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return false;
  if (/\s/.test(candidate)) return false;
  const normalized = candidate.split("\\").join("/");
  return OWN_DOC_FILES.has(normalized) || OWN_DOC_DIRS.some((dir) => normalized.startsWith(dir));
}

/** `票据 03` / `票据 03、05` / `票 03` 里出现的编号。 */
export function extractTicketRefs(text) {
  const normalized = normalize(text);
  const numbers = new Set();
  for (const match of normalized.matchAll(/票[据]?\s*((?:\d{2}(?:[、,，/]\s*)?)+)/g)) {
    for (const num of match[1].matchAll(/\d{2}/g)) numbers.add(num[0]);
  }
  return [...numbers].sort();
}

/** 一张票的 `Blocked by:` 行里出现的编号；`无（...）` 表示没有。 */
export function extractBlockedBy(text) {
  const normalized = normalize(text);
  const match = normalized.match(/^\*\*Blocked by:\*\*\s*(.*)$/m);
  if (!match) return null;
  const value = match[1].trim();
  if (/^无/.test(value)) return [];
  const numbers = [];
  for (const num of value.matchAll(/\d{2}/g)) numbers.push(num[0]);
  return [...new Set(numbers)].sort();
}

function listIssueFiles() {
  if (!existsSync(ISSUE_DIR)) return [];
  return readdirSync(ISSUE_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, number: (ISSUE_NUM.exec(name) ?? [])[1] }))
    .filter((entry) => entry.number !== undefined)
    .sort((a, b) => a.number.localeCompare(b.number));
}

function collectDocFiles() {
  const files = [];
  for (const dir of ["docs", "docs/adr", "docs/agents", "docs/design"]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const name of readdirSync(abs)) {
      if (name.endsWith(".md")) files.push(join(abs, name));
    }
  }
  for (const name of ["GLOSSARY.md", "AGENTS.md", "CODING_STANDARDS.md"]) {
    const abs = join(ROOT, name);
    if (existsSync(abs)) files.push(abs);
  }
  return files;
}

export function checkDocs(root = ROOT) {
  const problems = [];
  const issues = listIssueFiles();
  const issueNumbers = new Set(issues.map((entry) => entry.number));

  // 1 + 2 + 4：文档里引用的路径与票据编号
  const docFiles = collectDocFiles();
  if (existsSync(SPEC_PATH)) docFiles.push(SPEC_PATH);
  for (const name of readdirSyncSafe(ISSUE_DIR)) {
    docFiles.push(join(ISSUE_DIR, name));
  }

  for (const file of docFiles) {
    const text = readFileSync(file, "utf8");
    const rel = relPath(root, file);

    for (const ref of extractRefs(text)) {
      const abs = join(root, ref.path);
      if (!existsSync(abs)) {
        problems.push(`${rel}:${ref.line} 引用的路径不存在：${ref.path}`);
      }
    }

    for (const num of extractTicketRefs(text)) {
      if (!issueNumbers.has(num)) {
        problems.push(`${rel} 引用了不存在的票据编号：${num}`);
      }
    }
  }

  // 3：每张票的 Blocked by 都有对应票据
  for (const issue of issues) {
    const text = readFileSync(join(ISSUE_DIR, issue.name), "utf8");
    const blockedBy = extractBlockedBy(text);
    if (blockedBy === null) {
      problems.push(`.scratch/pi-extension-suite/issues/${issue.name} 缺少 **Blocked by:** 行`);
      continue;
    }
    for (const num of blockedBy) {
      if (!issueNumbers.has(num)) {
        problems.push(
          `.scratch/pi-extension-suite/issues/${issue.name} 的 Blocked by 指向不存在的票据：${num}`,
        );
      }
      if (num === issue.number) {
        problems.push(`.scratch/pi-extension-suite/issues/${issue.name} 把自己列为 Blocked by`);
      }
    }
  }

  // 依赖必须可解：挡住别人的票自己得存在（上面查过），且编号更小的票不能依赖编号更大的票
  for (const issue of issues) {
    const text = readFileSync(join(ISSUE_DIR, issue.name), "utf8");
    for (const num of extractBlockedBy(text) ?? []) {
      if (num > issue.number) {
        problems.push(
          `.scratch/pi-extension-suite/issues/${issue.name} 依赖了编号更大的票据 ${num}（依赖图会成环或不按序编号）`,
        );
      }
    }
  }

  return problems;
}

function readdirSyncSafe(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
}

function relPath(root, file) {
  return file.slice(root.length + 1).split("\\").join("/");
}

function main() {
  if (!existsSync(join(ROOT, ".scratch/pi-extension-suite"))) {
    console.log("check:docs 跳过：本机没有 .scratch/pi-extension-suite（新克隆的仓库只有代码与 README）。");
    return;
  }
  const problems = checkDocs(ROOT);
  if (problems.length === 0) {
    console.log("check:docs 通过：文档交叉引用一致。");
    return;
  }
  console.error(`check:docs 发现 ${problems.length} 处问题：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
