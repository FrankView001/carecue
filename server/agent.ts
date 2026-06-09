import OpenAI from 'openai'
import { z } from 'zod'
import { zodResponseFormat } from 'openai/helpers/zod'
import FirecrawlApp from '@mendable/firecrawl-js'
import type { ConsultationAnswer, RuleResult, ScenarioKey } from './rules.ts'
import type { AiChatMessage } from './ai-prompt.ts'

export type AiAgentStateInput = {
  answers: ConsultationAnswer[]
  chatMessages: AiChatMessage[]
  chiefComplaint: string
  ruleResult: RuleResult
  scenario: ScenarioKey
}

export const StateExtractionSchema = z.object({
  currentSymptoms: z.array(z.string()).describe("当前已提取的所有症状"),
  possibleConditions: z.array(z.string()).describe("疑似方向"),
  missingCriticalInfo: z.array(z.string()).describe("缺失的关键鉴别信息"),
  searchQueries: z.array(z.string()).describe("需要执行的权威检索词，如果不需要可以为空"),
  isInformationSufficient: z.boolean().describe("当前信息是否已经足够生成安全的报告"),
  hasRedFlag: z.boolean().describe("是否触发致命红旗急症（如心梗特征）")
})

export type StateExtraction = z.infer<typeof StateExtractionSchema>

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY || 'dummy',
  defaultHeaders: {
    'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost:5173',
    'X-OpenRouter-Title': process.env.OPENROUTER_APP_TITLE || 'CareCue',
  },
})

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY || 'dummy'
})

export async function extractState(input: AiAgentStateInput): Promise<StateExtraction> {
  const systemPrompt = `你是一个专业的医疗分诊AI助手。你的任务是从用户的对话中提取当前的症状、疑似疾病方向、还缺失的鉴别信息，并根据需要生成用于查询权威医疗信息的检索词。

【权威检索规范】
当你生成 searchQueries 时，必须在检索词后加上限定的权威网站范围（使用 site:xxx）。
根据项目产品需求文档 (PRD 第9.2节)，必须严格限定在以下权威来源白名单内：
- 国家卫健委: site:nhc.gov.cn
- 国家药监局: site:nmpa.gov.cn
- 三甲医院官方科普/丁香园等: site:dxy.cn
- 中国CDC: site:chinacdc.cn
- 医学会/专业指南/默沙东: site:msdmanuals.cn
- WHO: site:who.int
- NHS: site:nhs.uk

示例："胸痛 刺痛 呼吸加重 鉴别诊断 (site:nhc.gov.cn OR site:msdmanuals.cn OR site:dxy.cn)"

当前用户主诉：${input.chiefComplaint}
规则初步判断的紧急程度：${input.ruleResult.urgencyLevel}
请基于以上信息及后续对话历史，输出结构化的状态提取结果。`

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...input.chatMessages.map((msg): OpenAI.Chat.ChatCompletionMessageParam => {
      if (msg.role === 'user') {
        return { role: 'user', content: msg.content }
      } else {
        return { role: 'assistant', content: msg.content }
      }
    })
  ]

  const completion = await openai.chat.completions.create({
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-pro',
    messages,
    response_format: zodResponseFormat(StateExtractionSchema, 'state_extraction'),
    temperature: 0.1,
  })

  const rawContent = completion.choices[0]?.message?.content
  if (!rawContent) {
    throw new Error('Failed to extract state: no content from AI.')
  }

  return JSON.parse(rawContent) as StateExtraction
}

export async function executeSearches(queries: string[]) {
  if (!queries || queries.length === 0) return []

  const searchPromises = queries.map((query) =>
    firecrawl.search(query, {
      limit: 2,
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true
      }
    })
  )

  const results = await Promise.allSettled(searchPromises)
  
  return results
    .filter((r) => r.status === 'fulfilled' && (r.value as any).success !== false)
    .flatMap((r) => (r as PromiseFulfilledResult<any>).value.data || [])
}

export type AgentDecision = {
  type: 'ask_question' | 'generate_report'
  question?: string
  options?: string[]
}

export async function decideNextStep(state: StateExtraction, searchResults: any[]): Promise<AgentDecision> {
  const systemPrompt = `你是一个专业的医疗分诊AI助手。
当前提取的状态如下：
- 提取症状：${state.currentSymptoms.join(', ')}
- 疑似方向：${state.possibleConditions.join(', ')}
- 缺失信息：${state.missingCriticalInfo.join(', ')}

权威检索参考资料：
${JSON.stringify(searchResults.map(r => ({ title: r.metadata?.title, url: r.metadata?.sourceURL, markdown: r.markdown?.substring(0, 300) })))}

请决定下一步是继续追问还是生成最终报告。
如果信息充足（isInformationSufficient）或者触发致命红旗急症（hasRedFlag），请直接生成最终报告。
否则，请针对“缺失信息”生成一个口语化的追问问题，并提供2-4个明确的选项。`

  const DecisionSchema = z.object({
    type: z.enum(['ask_question', 'generate_report']),
    question: z.string().optional().describe("如果继续追问，口语化的问题文本"),
    options: z.array(z.string()).optional().describe("如果继续追问，2-4个明确的选项按钮文本")
  })

  const completion = await openai.chat.completions.create({
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-pro',
    messages: [{ role: 'system', content: systemPrompt }],
    response_format: zodResponseFormat(DecisionSchema, 'agent_decision'),
    temperature: 0.2,
  })

  const rawContent = completion.choices[0]?.message?.content
  if (!rawContent) {
    throw new Error('Failed to decide next step: no content from AI.')
  }

  return JSON.parse(rawContent) as AgentDecision
}

export async function runAgentWorkflow(input: AiAgentStateInput) {
  // 步骤 1：状态理解与关键词提取
  const state = await extractState(input)

  // 步骤 2：定向权威检索 (只有新的 searchQueries 才会触发)
  // 这里在实际业务中应当根据上下文记录去重，避免重复搜索
  const searchResults = await executeSearches(state.searchQueries || [])

  // 步骤 3 & 4：交叉验证与决策路由
  const decision = await decideNextStep(state, searchResults)

  return {
    state,
    searchResults: searchResults.map(r => ({ title: r.metadata?.title, url: r.metadata?.sourceURL })),
    decision
  }
}

