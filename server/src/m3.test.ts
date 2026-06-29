// M3 测试：扩展能力（10 组症状 / extract_facts / hypothesis / search_medical / Guard 5 条 / PG 落库）。
// 运行：tsx server/src/m3.test.ts

import assert from 'node:assert/strict'
import { createM3Engine, ConsultEngine } from './agent/loop.ts'
import { loadKnowledge } from './knowledge/loader.ts'
import { createM3ToolRegistry } from './tools/index.ts'
import { RuleExtractor } from './agent/extractor.ts'
import { Workspace } from './agent/workspace.ts'
import { guard, guardReport } from './agent/guard.ts'
import { MemoryTracer, PrismaTraceSink, type TracePersistenceClient } from './agent/trace.ts'
import { DeepSeekLlm, type ChatRequest, type ChatResponse, type CompleteFn } from './agent/llm.ts'
import type { SearchClient } from './agent/search.ts'
import type { ToolContext } from './tools/index.ts'
import { addHypothesisTool } from './tools/addHypothesis.ts'
import { updateHypothesisTool } from './tools/updateHypothesis.ts'
import { searchMedicalTool } from './tools/searchMedical.ts'

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
function baseCtx(ws: Workspace, extra: Partial<ToolContext> = {}): ToolContext {
  return { workspace: ws, knowledge, lastUserMessage: '', extractor: new RuleExtractor(knowledge), ...extra }
}
function toolCall(name: string, args: unknown): ChatResponse {
  return { choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] }
}

console.log('M3 扩展能力')

// ── 知识库 10 组症状 ────────────────────────────────────────────────────────────

await test('知识库覆盖 10 组症状，每组有红旗与护理建议', () => {
  const groups = ['头晕', '头痛', '腹痛', '发热', '咳嗽', '皮疹', '腹泻', '咽喉痛', '腰背痛', '眼睛不适']
  for (const g of groups) {
    assert.ok(knowledge.lookupRedFlags([g]).length >= 1, `${g} 应有红旗`)
    assert.ok(knowledge.carePlan([g]).length >= 1, `${g} 应有护理建议`)
  }
})

await test('10 组症状各自首轮都能加载红旗并追问', async () => {
  const inputs: Array<[string, string]> = [
    ['咳嗽', '我一直咳嗽'],
    ['发热', '有点发烧'],
    ['皮疹', '身上起疹子了'],
    ['咽喉痛', '嗓子疼'],
    ['腰背痛', '腰疼得厉害'],
    ['眼睛不适', '眼睛疼还发红'],
  ]
  for (const [, msg] of inputs) {
    const engine = createM3Engine()
    const r = await engine.consult({ caseId: `g-${msg}`, userMessage: msg })
    assert.equal(r.type, 'followup', `「${msg}」应进入追问`)
    assert.ok(engine.getWorkspace(`g-${msg}`)!.redFlagsLoaded)
  }
})

// ── extract_facts ──────────────────────────────────────────────────────────────

await test('RuleExtractor 抽取症状(口语)/年龄/性别/时长', () => {
  const e = new RuleExtractor(knowledge).extract('我28岁女性，肚子疼两天了，还有点拉肚子')
  assert.deepEqual(e.symptoms.sort(), ['腹泻', '腹痛'].sort())
  assert.equal(e.age, 28)
  assert.equal(e.sex, 'female')
  assert.equal(e.facts.duration, '两天')
})

await test('extract_facts 在主循环中取代 naive 种子（口语也能识别）', async () => {
  const engine = createM3Engine()
  const r = await engine.consult({ caseId: 'ex1', userMessage: '我拉肚子，30岁男的' })
  const ws = engine.getWorkspace('ex1')!
  assert.ok(ws.symptoms.includes('腹泻'), '口语「拉肚子」应被抽取为腹泻')
  assert.equal(ws.age, 30)
  assert.equal(ws.sex, 'male')
  assert.equal(r.type, 'followup')
})

// ── hypothesis 工具 ──────────────────────────────────────────────────────────────

await test('add_hypothesis / update_hypothesis 调整权重并 clamp', async () => {
  const ws = new Workspace('h1')
  const ctx = baseCtx(ws)
  addHypothesisTool.run({ name: '紧张性头痛', initialEvidence: '双侧胀痛' }, ctx)
  assert.equal(ws.hypotheses.length, 1)
  assert.equal(ws.hypotheses[0].weight, 0.5)

  updateHypothesisTool.run({ name: '紧张性头痛', delta: 0.7, evidence: '压力大时加重' }, ctx)
  assert.equal(ws.hypotheses[0].weight, 1, '应 clamp 到 1')
  assert.ok(ws.hypotheses[0].supportingEvidence.includes('压力大时加重'))

  updateHypothesisTool.run({ name: '紧张性头痛', delta: -0.3, evidence: '夜里也痛醒' }, ctx)
  assert.ok(Math.abs(ws.hypotheses[0].weight - 0.7) < 1e-9)
  assert.ok(ws.hypotheses[0].againstEvidence.includes('夜里也痛醒'))

  const miss = await updateHypothesisTool.run({ name: '不存在', delta: 0.1 }, ctx)
  assert.equal(miss.ok, false)
})

// ── search_medical ───────────────────────────────────────────────────────────────

await test('search_medical：有客户端则写回，无客户端优雅失败', async () => {
  const ws = new Workspace('s1')
  const fake: SearchClient = {
    kind: 'fake',
    async search(query) {
      return { query, snippets: [{ title: 't', url: 'http://u', snippet: 's' }], sources: [{ title: 't', url: 'http://u' }] }
    },
  }
  const ok = await searchMedicalTool.run({ query: '头晕 胸闷 鉴别' }, baseCtx(ws, { search: fake }))
  assert.equal(ok.ok, true)
  assert.ok(ws.searchResults['头晕 胸闷 鉴别'])

  const none = await searchMedicalTool.run({ query: 'x' }, baseCtx(ws, { search: undefined }))
  assert.equal(none.ok, false, '无客户端应返回失败而非抛错')
})

await test('search_medical 失败时对话仍继续（DeepSeek 决策 + 工具失败反馈）', async () => {
  let call = 0
  const complete: CompleteFn = async (req: ChatRequest) => {
    call++
    if (call === 1) return toolCall('search_medical', { query: '头晕 胸闷' }) // 无 search 客户端 → 失败
    const content = req.messages.find((m) => m.role === 'user')?.content ?? ''
    const pending = /([^\s;：:]+)\[[^\]]*\]=pending/.exec(content)?.[1] ?? '心源性'
    return toolCall('ask_user', { question: `关于「${pending}」`, target: pending })
  }
  const llm = new DeepSeekLlm([{ name: 'deepseek', model: 'deepseek-chat', complete }])
  const engine = new ConsultEngine({ llm, knowledge, registry: createM3ToolRegistry() }) // 不配 search
  const r = await engine.consult({ caseId: 'srf', userMessage: '我头晕胸闷' })
  assert.equal(r.type, 'followup', '检索失败后应继续追问')
  assert.ok(call >= 2)
})

// ── Guard 全部 5 条规则 ──────────────────────────────────────────────────────────

await test('Guard 规则1：症状已知未加载红旗 → 首步强制 lookup（forced）', async () => {
  const engine = createM3Engine()
  await engine.consult({ caseId: 'r1', userMessage: '头痛' })
  assert.equal(engine.getWorkspace('r1')!.redFlagsLoaded, true)
})

await test('Guard 规则2：有 pending 红旗 → 禁止 generate_report', () => {
  const ws = new Workspace('r2')
  ws.loadRedFlags([{ name: 'X', severity: 'high', ask: 'q', positiveSignals: [] }])
  assert.equal(guard({ tool: 'generate_report', input: {} }, ws).allow, false)
})

await test('Guard 规则3：重复问题 → 拒绝 ask_user', () => {
  const ws = new Workspace('r3')
  ws.recordQuestion('Q?')
  assert.equal(guard({ tool: 'ask_user', input: { question: 'Q?' } }, ws).allow, false)
})

await test('Guard 规则4：报告禁语 → 拦截', () => {
  assert.equal(guardReport('这一定是阑尾炎').allow, false)
  assert.equal(guardReport('注意休息，必要时就医').allow, true)
})

await test('Guard 规则5：高危红旗 positive → 强制急症', async () => {
  const engine = createM3Engine()
  const id = 'r5'
  await engine.consult({ caseId: id, userMessage: '头痛' })
  const r = await engine.consult({ caseId: id, userMessage: '突然炸裂样剧痛，还喷射性呕吐' })
  assert.equal(r.type, 'emergency')
})

// ── 可观测性落 PG（PrismaTraceSink） ─────────────────────────────────────────────

await test('PrismaTraceSink：trace 写 agent_traces，snapshot upsert agent_workspaces', async () => {
  const traceRows: Record<string, unknown>[] = []
  const wsUpserts: { where: { id: string }; create: Record<string, unknown> }[] = []
  const client: TracePersistenceClient = {
    agentTrace: { async create(args) { traceRows.push(args.data); return {} } },
    agentWorkspace: { async upsert(args) { wsUpserts.push(args); return {} } },
  }
  const tracer = new MemoryTracer({ sink: new PrismaTraceSink(client) })
  const engine = new ConsultEngine({ llm: new (await import('./agent/llm.ts')).MockLlm(), knowledge, registry: createM3ToolRegistry(), tracer })
  await engine.consult({ caseId: 'pg1', userMessage: '我头晕胸闷' })
  await new Promise((r) => setTimeout(r, 20)) // 等 fire-and-forget 落库

  assert.ok(traceRows.some((d) => d.kind === 'tool' && d.name === 'lookup_red_flags'), '应写入工具 trace')
  assert.ok(wsUpserts.some((u) => u.where.id === 'pg1'), '应 upsert workspace 快照')
  const snap = wsUpserts.find((u) => u.where.id === 'pg1')!
  assert.equal(snap.create.id, 'pg1')
})

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 个用例失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
