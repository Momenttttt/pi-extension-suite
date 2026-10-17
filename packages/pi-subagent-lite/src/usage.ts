/**
 * 用量折算：把子会话的 `getSessionStats()` 折成 pi 的工具结果 `usage`。纯层。
 *
 * 为什么要回传：pi 会把工具结果里的 `usage` 记进父会话的 `toolResult` 消息，`getSessionStats`
 * 再把它算进合计（`addUsageToTotals` 会读 `usage.cost.total`，缺 `cost` 直接抛）。**账要准，
 * 不能省**：子代理的用量一律回传。
 */

/** 与 pi-ai 的 `Usage` 结构对齐（pi 根不导出该类型，自己声明最小形状）。 */
export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** `AgentSession.getSessionStats()` 里我们需要的部分。 */
export interface SessionStatsLike {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}

/**
 * 折算规则：token 分项与总量照抄；代价只有总额（`SessionStats` 不给分项），所以分项记 0、
 * 总额放 `cost.total`——合计口径正确，明细不猜。
 */
export function usageFromSessionStats(stats: SessionStatsLike): SubagentUsage {
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: stats.cost,
    },
  };
}

export const EMPTY_USAGE: SubagentUsage = usageFromSessionStats({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
});
