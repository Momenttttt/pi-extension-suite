/**
 * 跨包读态互通的事件契约。
 *
 * 04 与 01 都只是"可选联动"：谁缺席另一方照常工作。所以这里既没有 import，也没有
 * 启动期握手——只是一个字符串常量 + 一份形状约定。
 *
 * 选这条路的理由（票据 03 要求记录选择依据）：
 *   - `pi.events` 是 pi 自己给的共享事件总线，不用引入新的配置文件契约；
 *   - 发布方（记忆插件）只要 `emit`，接收方（本插件）只要 `on`，任一方没装都不会报错；
 *   - 换成"由配置声明的读态提供方"要多定义一层配置形状与解析规则，而收益相同。
 */
export const READ_STATE_EVENT = "read-guard/file-read";

/** 事件载荷：一次"某路径刚被读过"的登记。 */
export interface ReadStateEventPayload {
  /** 绝对路径（接收方自己算路径键）。 */
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  /** 文本内容的 sha256；没有（图片 / 二进制）就不带。 */
  contentHash?: string;
  kind: "full" | "ranged" | "truncated";
}
