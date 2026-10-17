#!/usr/bin/env node
/**
 * check-docs.mjs 的最小测试。
 *
 * 两条最容易写错的规则在这里钉住：
 *   - 先归一化 CRLF（本机工作树全是 CRLF，不归一化会假报"引用不存在"）
 *   - 范围写法（`docs/adr/0001..0007`）不是路径，不能拿去 existsSync
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractBlockedBy, extractRefs, extractTicketRefs, normalize } from "./check-docs.mjs";

test("normalize 把 CRLF 与裸 CR 都折成 LF", () => {
  assert.equal(normalize("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("extractRefs 认 markdown 链接与行内代码路径", () => {
  const refs = extractRefs("见 [设计](docs/design/README.md) 与 `docs/adr/0001-four-independent-packages.md`。");
  assert.deepEqual(
    refs.map((ref) => ref.path),
    ["docs/design/README.md", "docs/adr/0001-four-independent-packages.md"],
  );
});

test("extractRefs 跳过范围写法", () => {
  const refs = extractRefs("决策见 `docs/adr/0001..0007`，票据见 `docs/design/*.md`。");
  assert.deepEqual(refs, []);
});

test("extractRefs 跳过 URL、锚点与本机绝对路径", () => {
  const refs = extractRefs(
    [
      "[npm](https://www.npmjs.com/package/x)",
      "[锚点](#section)",
      "`D:\\tools\\node\\package.json`",
      "`/opt/refs/docs/design/README.md`",
    ].join("\n"),
  );
  assert.deepEqual(refs, []);
});

test("extractRefs 在 CRLF 文本上仍然给出正确的行号", () => {
  const refs = extractRefs("第一行\r\n第二行 `docs/design/does-not-exist.md`\r\n");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, "docs/design/does-not-exist.md");
  assert.equal(refs[0].line, 2);
});

test("extractTicketRefs 认多种并列写法", () => {
  assert.deepEqual(extractTicketRefs("见票据 03、05 与 票 09/11，还有票据12"), [
    "03",
    "05",
    "09",
    "11",
    "12",
  ]);
});

test("extractBlockedBy 解析编号，无则空数组", () => {
  assert.deepEqual(extractBlockedBy("**Blocked by:** 02, 05\n"), ["02", "05"]);
  assert.deepEqual(extractBlockedBy("**Blocked by:** 无（可立即开始）\n"), []);
});

test("extractBlockedBy 在 CRLF 文本上也能命中", () => {
  assert.deepEqual(extractBlockedBy("> x\r\n\r\n**Blocked by:** 01\r\n\r\n**Status:** ready\r\n"), [
    "01",
  ]);
});

test("extractBlockedBy 缺行时返回 null（调用方据此报缺失）", () => {
  assert.equal(extractBlockedBy("# 票\n\n没有这一行\n"), null);
});

test("extractRefs 不把 pi 自己的文档当成本仓库路径", () => {
  const refs = extractRefs(
    [
      "契约看 `docs/extensions.md:114-118` 与 `docs/compaction.md`。",
      "[pi 文档](docs/packages.md)",
      "范围写法：`docs/{extensions,compaction,sdk}.md`",
    ].join("\n"),
  );
  assert.deepEqual(refs, []);
});

test("extractRefs 认本仓库自己的文档路径", () => {
  const refs = extractRefs(
    [
      "见 `docs/design/01-zcode-memory-plugin.md` 与 `docs/adr/0005-read-watermark-aligns-with-claude-code.md`。",
      "[契约](docs/pi-contract-map.md)",
      "`GLOSSARY.md` 与 `docs/agents/domain.md`",
    ].join("\n"),
  );
  assert.deepEqual(
    refs.map((ref) => ref.path),
    [
      "docs/design/01-zcode-memory-plugin.md",
      "docs/adr/0005-read-watermark-aligns-with-claude-code.md",
      "docs/pi-contract-map.md",
      "GLOSSARY.md",
      "docs/agents/domain.md",
    ],
  );
});
