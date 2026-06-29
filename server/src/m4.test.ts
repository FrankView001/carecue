// M4：用户测试与优化。模拟 20 例真实咨询 + 边界用例，校验设计文档第五部分成功标准：
//   ① 端到端跑通真实案例并给出合理报告
//   ② 任一工具失败 1 次对话仍继续
//   ③ 高危红旗用例 100% 触发急症
//   ④ 单次咨询 LLM 调用 ≤ 8 次
//   ⑤ 平均响应时间 ≤ 8 秒/轮（mock 下衡量框架开销）
// 运行：tsx server/src/m4.test.ts

import assert from 'node:assert/strict'
import { ConsultEngine } from './agent/loop.ts'
import { loadKnowledge } from './knowledge/loader.ts'
import { createM3ToolRegistry } from './tools/index.ts'
import { MockLlm } from './agent/llm.ts'
import { MemoryTracer } from './agent/trace.ts'
import { lookupRedFlagsTool } from './tools/lookupRedFlags.ts'
import type { Tool } from './tools/index.ts'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failures++
    console.log(`  ❌ ${name}\n     ${err instanceof Error ? err.message : String(err)}`)
  }
}

const knowledge = loadKnowledge()
const BANNED = ['确诊', '一定是', '必须服用']
const GROUPS = ['头晕', '头痛', '腹痛', '发热', '咳嗽', '皮疹', '腹泻', '咽喉痛', '腰背痛', '眼睛不适']
const FIRST_MSG: Record<string, string> = {
  头晕: '我头晕还有点胸闷',
  头痛: '这两天一直头痛',
  腹痛: '我腹痛，肚子疼得厉害',
  发热: '我有点发烧',
  咳嗽: '我一直咳嗽',
  皮疹: '身上起了疹子',
  腹泻: '我拉肚子了',
  咽喉痛: '嗓子疼',
  腰背痛: '腰疼得厉害',
  眼睛不适: '眼睛疼还发红',
}

function newEngine(tracer?: MemoryTracer) {
  return new ConsultEngine({ llm: new MockLlm(), knowledge, registry: createM3ToolRegistry(), tracer })
}
function llmCalls(tracer: MemoryTracer, caseId: string): number {
  return tracer.events(caseId).filter((e) => e.kind === 'decision' && (e.data as { forced?: boolean }).forced === false).length
}

console.log('M4 用户测试与优化（20 例 + 成功标准）')

// ── ①④⑤ 10 组正常咨询：逐轮排除 → 合理非确诊报告，并统计 LLM 调用与耗时 ──────────────
const perTurnMs: number[] = []
let maxLlmCalls = 0

await test('10 组正常咨询 → 非确诊报告（无禁语 / R0 / LLM 调用≤8）', async () => {
  for (const g of GROUPS) {
    const tracer = new MemoryTracer()
    const engine = newEngine(tracer)
    const id = `normal-${g}`
    let turns = 0
    const t0 = Date.now()
    let r = await engine.consult({ caseId: id, userMessage: FIRST_MSG[g] })
    turns++
    let guard = 0
    while (r.type === 'followup' && guard++ < 10) {
      r = await engine.consult({ caseId: id, userMessage: '没有，这些情况都没有' })
      turns++
    }
    perTurnMs.push((Date.now() - t0) / turns)

    assert.equal(r.type, 'final_report', `${g} 应收敛到报告`)
    if (r.type !== 'final_report') continue
    assert.equal(r.riskLevel, 'R0', `${g} 全部排除应为 R0`)
    assert.ok(r.report.careAdvice.length > 0, `${g} 应有护理建议`)
    assert.ok(r.report.referral.department.length > 0, `${g} 应有就医科室`)
    for (const p of BANNED) assert.ok(!r.rendered.includes(p), `${g} 报告含禁语「${p}」`)

    const calls = llmCalls(tracer, id)
    maxLlmCalls = Math.max(maxLlmCalls, calls)
    assert.ok(calls <= 8, `${g} 单次咨询 LLM 调用应≤8，实际 ${calls}`)
  }
})

// ── ③ 10 组急症咨询：命中高危红旗 100% 触发 emergency ────────────────────────────
let emergencyHits = 0

await test('10 组急症咨询 → 100% 触发急症提示（高危红旗召回）', async () => {
  for (const g of GROUPS) {
    const flags = knowledge.lookupRedFlags([g])
    const highFlag = flags.find((f) => f.severity === 'high')
    assert.ok(highFlag, `${g} 应至少有一个高危红旗`)
    assert.ok(highFlag!.positiveSignals.length > 0, `${g} 高危红旗应有阳性信号`)
    // MockLlm 按知识库顺序逐条问；高危红旗排在前，首个追问即针对它。
    assert.equal(flags[0].severity, 'high', `${g} 首个红旗应为高危（保证首问即高危）`)

    const engine = newEngine()
    const id = `emg-${g}`
    const r1 = await engine.consult({ caseId: id, userMessage: FIRST_MSG[g] })
    assert.equal(r1.type, 'followup', `${g} 首轮应追问`)
    const signal = flags[0].positiveSignals[0]
    const r2 = await engine.consult({ caseId: id, userMessage: `有，${signal}` })
    assert.equal(r2.type, 'emergency', `${g} 命中「${signal}」应触发急症`)
    if (r2.type === 'emergency') {
      assert.equal(r2.riskLevel, 'R3')
      assert.ok(r2.triggeredCombination.length > 0)
      emergencyHits++
    }
  }
  assert.equal(emergencyHits, GROUPS.length, '高危红旗召回率应为 100%')
})

// ── ② 工具失败一次对话仍继续 ─────────────────────────────────────────────────────
await test('工具失败一次：lookup 抛错一次，重试后对话继续', async () => {
  let calls = 0
  const flaky: Tool = {
    ...(lookupRedFlagsTool as Tool),
    run(input, ctx) {
      if (calls++ === 0) throw new Error('瞬时故障')
      return lookupRedFlagsTool.run(input as never, ctx)
    },
  }
  const registry = createM3ToolRegistry()
  registry.register(flaky)
  const engine = new ConsultEngine({ llm: new MockLlm(), knowledge, registry })
  const r = await engine.consult({ caseId: 'flaky4', userMessage: '我头晕胸闷' })
  assert.equal(r.type, 'followup')
  assert.equal(calls, 2)
})

// ── 边界：无法识别症状时不崩溃 ────────────────────────────────────────────────────
await test('边界：模糊描述「不太舒服」也能返回合法响应而不崩溃', async () => {
  const engine = newEngine()
  const r = await engine.consult({ caseId: 'vague', userMessage: '我就是有点不太舒服' })
  assert.ok(['followup', 'final_report', 'stage_report', 'emergency'].includes(r.type))
})

// ── 性能与召回汇总（设计文档第五部分） ───────────────────────────────────────────
const avgMs = perTurnMs.reduce((a, b) => a + b, 0) / perTurnMs.length
await test('成功标准汇总：召回 100% / LLM 调用≤8 / 轮均耗时≤8s', () => {
  assert.equal(emergencyHits, GROUPS.length)
  assert.ok(maxLlmCalls <= 8, `单咨询最大 LLM 调用 ${maxLlmCalls} 应≤8`)
  assert.ok(avgMs <= 8000, `轮均耗时 ${avgMs.toFixed(1)}ms 应≤8000`)
})

console.log(
  `\n指标：急症召回 ${emergencyHits}/${GROUPS.length} | 单咨询最大 LLM 调用 ${maxLlmCalls} | 轮均耗时 ${avgMs.toFixed(1)}ms`,
)
console.log(failures === 0 ? '全部通过 ✅' : `${failures} 个用例失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
