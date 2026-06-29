// M2 测试：接入真实 LLM（DeepSeek 决策类）+ 3 个真实症状 e2e + 路由 + 可观测性。
// 运行：tsx server/src/m2.test.ts
// 不触网：用注入的 CompleteFn 模拟「会读工作区的真实 tool-calling 模型」。

import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { createM1Engine, ConsultEngine } from './agent/loop.ts'
import { loadKnowledge } from './knowledge/loader.ts'
import { createM1ToolRegistry } from './tools/index.ts'
import { createConsultRouter } from './routes/consult.ts'
import { MemoryTracer } from './agent/trace.ts'
import {
  DeepSeekLlm,
  MockLlm,
  type ChatRequest,
  type ChatResponse,
  type CompleteFn,
  type ProviderConfig,
} from './agent/llm.ts'

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

const NEG = ['没有', '没', '无', '不', '未', '别']
function hasSignal(text: string, keywords: string[]): boolean {
  return keywords.some((k) => {
    const i = text.indexOf(k)
    if (i < 0) return false
    return !NEG.some((n) => text.slice(Math.max(0, i - 2), i).includes(n))
  })
}

const EMERGENCY_KEYWORDS = ['压榨', '放射', '冷汗', '反跳痛', '黑便', '呕血', '炸裂', '喷射', '一生最痛']

function toolCallResponse(name: string, args: unknown): ChatResponse {
  return {
    model: 'fake',
    usage: { total_tokens: 42 },
    choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
  }
}

/**
 * 模拟「读工作区做决策」的真实 tool-calling 模型：从请求里解析出工作区摘要与用户输入，
 * 按家庭医生策略选一个工具。覆盖真实 ChatRequest 的解析、tool_call 解析与多轮编排。
 */
function makeScriptedComplete(): CompleteFn {
  return async (req: ChatRequest): Promise<ChatResponse> => {
    const content = req.messages.find((m) => m.role === 'user')?.content ?? ''
    const userInput = /用户最新输入:\s*(.*)/.exec(content)?.[1] ?? ''

    const awaiting = /待回答红旗:\s*(\S+)/.exec(content)?.[1]
    if (awaiting) {
      const status = hasSignal(userInput, EMERGENCY_KEYWORDS) ? 'positive' : 'ruled_out'
      return toolCallResponse('update_red_flag', { name: awaiting, status, evidence: userInput })
    }

    if (/红旗:\s*未加载/.test(content)) {
      const symptoms = /症状:\s*(.*)/.exec(content)?.[1]?.split('、').filter(Boolean) ?? []
      return toolCallResponse('lookup_red_flags', { symptoms })
    }

    const pending = /([^\s;：:]+)\[[^\]]*\]=pending/.exec(content)?.[1]
    if (pending) {
      return toolCallResponse('ask_user', { question: `关于「${pending}」想确认一下`, target: pending })
    }

    return toolCallResponse('generate_report', {})
  }
}

function deepSeekWith(complete: CompleteFn, tracer?: MemoryTracer): DeepSeekLlm {
  const provider: ProviderConfig = { name: 'deepseek', model: 'deepseek-chat', complete }
  return new DeepSeekLlm([provider], tracer ? { tracer } : {})
}

console.log('M2 接入真实 LLM')

// ── 3 个真实症状 e2e（Mock LLM 驱动，验证主循环对任意红旗知识库通用） ─────────────────

await test('真实症状①：头痛逐轮排除 → 非确诊报告', async () => {
  const engine = createM1Engine()
  const id = 'head'
  assert.equal((await engine.consult({ caseId: id, userMessage: '这两天一直头痛' })).type, 'followup')
  assert.equal((await engine.consult({ caseId: id, userMessage: '不是突然剧痛，也没呕吐，脖子不硬' })).type, 'followup')
  assert.equal((await engine.consult({ caseId: id, userMessage: '清晨没加重，看东西正常，手脚有力' })).type, 'followup')
  const r = await engine.consult({ caseId: id, userMessage: '没发烧，太阳穴不痛，视力也正常' })
  assert.equal(r.type, 'final_report')
  if (r.type !== 'final_report') return
  assert.equal(r.riskLevel, 'R0')
  assert.ok(r.report.careAdvice.length > 0)
})

await test('真实症状②：腹痛命中急腹症 → emergency', async () => {
  const engine = createM1Engine()
  const id = 'belly'
  assert.equal((await engine.consult({ caseId: id, userMessage: '我腹痛，肚子疼得挺厉害' })).type, 'followup')
  const r = await engine.consult({ caseId: id, userMessage: '一松手反跳痛，而且越来越重' })
  assert.equal(r.type, 'emergency')
  if (r.type !== 'emergency') return
  assert.equal(r.riskLevel, 'R3')
  assert.ok(r.triggeredCombination.some((s) => s.includes('急腹症')))
})

await test('真实症状③：头晕胸闷逐轮排除 → 非确诊报告', async () => {
  const engine = createM1Engine()
  const id = 'dizzy'
  await engine.consult({ caseId: id, userMessage: '头晕，还有点胸闷' })
  await engine.consult({ caseId: id, userMessage: '胸口不闷痛，也没出汗' })
  await engine.consult({ caseId: id, userMessage: '手脚有力，说话清楚，看东西正常' })
  const r = await engine.consult({ caseId: id, userMessage: '心跳很平稳' })
  assert.equal(r.type, 'final_report')
})

// ── DeepSeekLlm：真实决策类的请求构造 / tool_call 解析 / 回退 ──────────────────────

await test('DeepSeekLlm：构造合规请求并解析 tool_call', async () => {
  let seen: ChatRequest | undefined
  const scripted = makeScriptedComplete()
  const llm = deepSeekWith(async (req) => {
    seen = req
    return scripted(req)
  })
  const engine = new ConsultEngine({ llm, knowledge: loadKnowledge(), registry: createM1ToolRegistry() })
  // 第一步 lookup 由 requiredAction 强制；这里直接验证 decide 的产物经由一次咨询体现。
  const r = await engine.consult({ caseId: 'ds1', userMessage: '我头晕胸闷' })
  assert.ok(seen, 'decide 应至少被调用一次')
  assert.equal(seen!.tool_choice, 'required')
  assert.equal(seen!.tools.length, 4, '应带 4 个工具')
  assert.ok(seen!.messages.some((m) => m.role === 'system' && m.content.includes('家庭医生')))
  assert.equal(r.type, 'followup')
})

await test('DeepSeekLlm：provider 失败时回退到下一个 provider', async () => {
  const tracer = new MemoryTracer()
  const bad: CompleteFn = async () => {
    throw new Error('deepseek 503')
  }
  const good = makeScriptedComplete()
  const llm = new DeepSeekLlm(
    [
      { name: 'deepseek', model: 'deepseek-chat', complete: bad },
      { name: 'openrouter', model: 'deepseek/deepseek-chat', complete: good },
    ],
    { tracer },
  )
  const engine = new ConsultEngine({ llm, knowledge: loadKnowledge(), registry: createM1ToolRegistry(), tracer })
  const r = await engine.consult({ caseId: 'ds2', userMessage: '我头晕胸闷' })
  assert.equal(r.type, 'followup', '回退后应正常追问')
  const events = tracer.events('ds2')
  assert.ok(events.some((e) => e.kind === 'error' && e.name === 'llm:deepseek'), '应记录 deepseek 失败')
  assert.ok(events.some((e) => e.kind === 'llm' && e.name === 'openrouter'), '应记录 openrouter 成功')
})

await test('DeepSeekLlm e2e：头晕胸闷多轮 → 非确诊报告', async () => {
  const llm = deepSeekWith(makeScriptedComplete())
  const engine = new ConsultEngine({ llm, knowledge: loadKnowledge(), registry: createM1ToolRegistry() })
  const id = 'ds-e2e'
  assert.equal((await engine.consult({ caseId: id, userMessage: '头晕胸闷' })).type, 'followup')
  assert.equal((await engine.consult({ caseId: id, userMessage: '胸口不痛，没出汗' })).type, 'followup')
  assert.equal((await engine.consult({ caseId: id, userMessage: '手脚有力，说话清楚' })).type, 'followup')
  const r = await engine.consult({ caseId: id, userMessage: '心跳平稳' })
  assert.equal(r.type, 'final_report')
})

await test('DeepSeekLlm + Guard：模型违规出报告 → 被拒后改为追问', async () => {
  let call = 0
  // 第一次决策故意违规（有 pending 还要出报告）；被 Guard 拒后第二次改为合规追问。
  const complete: CompleteFn = async (req) => {
    call++
    if (call === 1) return toolCallResponse('generate_report', {})
    const content = req.messages.find((m) => m.role === 'user')?.content ?? ''
    const pending = /([^\s;：:]+)\[[^\]]*\]=pending/.exec(content)?.[1] ?? '心源性'
    return toolCallResponse('ask_user', { question: `关于「${pending}」`, target: pending })
  }
  const tracer = new MemoryTracer()
  const llm = deepSeekWith(complete, tracer)
  const engine = new ConsultEngine({ llm, knowledge: loadKnowledge(), registry: createM1ToolRegistry(), tracer })
  const r = await engine.consult({ caseId: 'ds-guard', userMessage: '头晕胸闷' })
  assert.equal(r.type, 'followup', 'Guard 拒绝违规出报告后应恢复为追问')
  assert.ok(tracer.events('ds-guard').some((e) => e.kind === 'guard' && e.name === 'generate_report'))
})

// ── 路由 + 可观测性 ─────────────────────────────────────────────────────────────

await test('POST /api/consult：HTTP 往返 + 校验 + 多轮', async () => {
  const tracer = new MemoryTracer()
  const engine = new ConsultEngine({
    llm: new MockLlm(),
    knowledge: loadKnowledge(),
    registry: createM1ToolRegistry(),
    tracer,
  })
  const app = express()
  app.use(express.json())
  app.use(createConsultRouter(engine))
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}/api/consult`

  try {
    const bad = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '头晕' }),
    })
    assert.equal(bad.status, 400, '缺 caseId 应 400')

    const r1 = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseId: 'http1', message: '我头晕胸闷' }),
    })
    assert.equal(r1.status, 200)
    const body1 = (await r1.json()) as { type: string }
    assert.equal(body1.type, 'followup')

    // 可观测性：本次会话应记录工具调用与快照。
    const events = tracer.events('http1')
    assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'lookup_red_flags'))
    assert.ok(events.some((e) => e.kind === 'snapshot'))
  } finally {
    server.close()
  }
})

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 个用例失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
