// Guard：常驻拦截器（设计文档 2.6）。每次工具调用前执行；拒绝时把 reason 反馈给
// LLM 重新决策，而不是抛错。报告文本另有 guardReport 做发布前复核。

import type { ToolCall } from '../schemas/index.ts'
import type { Workspace } from './workspace.ts'

export type GuardVerdict =
  | { allow: true }
  | { allow: false; reason: string; suggest?: ToolCall }

/** 被禁短语（设计文档 2.6 规则 4）：确诊式 / 指令式给药剂量。 */
const BANNED_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /确诊/, label: '确诊' },
  { re: /一定是/, label: '一定是' },
  { re: /必定是/, label: '必定是' },
  { re: /必须服用/, label: '必须服用' },
  // 指令式剂量：必须/请/每次 ... 数字 + 剂量单位（不误伤「每日不超过 X」类安全上限说明）
  { re: /(必须|请|需)(服用|口服|吃)[^。\n]*?\d+(\.\d+)?\s*(mg|毫克|g|克|ml|毫升|片|粒)/, label: '给药剂量指令' },
]

/**
 * 动作级 Guard（pre-execution）。
 * 规则 1（症状非空但红旗未加载）与规则 5（高危 positive 强制急症）由主循环的
 * requiredAction 强制实现，这里覆盖规则 2、3。
 */
export function guard(action: ToolCall, ws: Workspace): GuardVerdict {
  // 防空转：红旗已加载时拒绝重复检索（真实 LLM 可能反复调用，避免无进展循环）。
  if (action.tool === 'lookup_red_flags' && ws.redFlagsLoaded) {
    return {
      allow: false,
      reason: '红旗已加载，无需重复检索；请基于现有红旗 ask_user 追问或 update_red_flag 更新状态。',
    }
  }

  // 规则 2：有 pending 红旗 → 禁止 generate_report（高危 positive 时放行急症）。
  if (action.tool === 'generate_report') {
    if (ws.positiveHighRiskRedFlag()) return { allow: true }
    if (ws.pendingRedFlags().length > 0) {
      return {
        allow: false,
        reason: `还有未排查的红旗（${ws.pendingRedFlags().map((r) => r.name).join('、')}），不能出报告，请继续追问或更新红旗状态。`,
      }
    }
  }

  // 规则 3：重复问题 → 拒绝 ask_user，要求换问法。
  if (action.tool === 'ask_user') {
    const input = action.input as { question?: string }
    const q = input?.question?.trim()
    if (q && ws.hasAskedQuestion(q)) {
      return { allow: false, reason: `这个问题已经问过了：「${q}」，请换一个角度或换一个问题。` }
    }
  }

  return { allow: true }
}

/** 报告发布前复核（规则 4）。返回违规短语供主循环要求重写。 */
export function guardReport(rendered: string): GuardVerdict {
  const hit = BANNED_PATTERNS.find((p) => p.re.test(rendered))
  if (hit) {
    return { allow: false, reason: `报告含被禁表述「${hit.label}」，需改写为非确诊、不含剂量指令的措辞。` }
  }
  return { allow: true }
}
