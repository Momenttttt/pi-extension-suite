/**
 * 测试夹具：一个只给用量、可选的慢工具。
 *
 * 它通过子代理 loader 的 `additionalExtensionPaths` 装进**子会话**，用来验证两件事：
 *   1. 子代理自己产生的用量会被父会话合计（桩 provider 的用量恒为 0，只有夹具工具能造出非零数）
 *   2. 中断能传进正在跑的工具（`slowMs`）
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const reportUsage: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "report_usage",
    label: "Report usage",
    description: "Test fixture: report a fixed usage without doing any work.",
    parameters: {
      type: "object",
      properties: {
        total: { type: "number" },
        slowMs: { type: "number" },
      },
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, params) => {
      const args = params as { total?: number; slowMs?: number };
      if (typeof args.slowMs === "number" && args.slowMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, args.slowMs));
      }
      const total = typeof args.total === "number" ? args.total : 4242;
      return {
        content: [{ type: "text", text: `fixture usage ${total}` }],
        details: {},
        usage: {
          input: total,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: total,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
  });
};

export default reportUsage;
export { reportUsage as reportUsageFactory };
