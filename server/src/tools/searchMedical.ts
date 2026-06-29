// search_medical：联网查权威资料（Firecrawl），把片段与来源写回 Workspace。
// 未配置检索客户端或检索失败时返回错误结果（不抛错），由主循环反馈给 LLM 换方法。

import { z } from 'zod'
import { SearchMedicalInput } from '../schemas/index.ts'
import type { Tool } from './types.ts'

type Input = z.infer<typeof SearchMedicalInput>

export const searchMedicalTool: Tool<Input> = {
  name: 'search_medical',
  description: '联网检索权威医学资料以验证假设或补充护理依据，返回片段与来源。',
  inputSchema: SearchMedicalInput,
  spec: {
    name: 'search_medical',
    description: '联网检索权威医学资料，返回片段与来源。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  async run(input, ctx) {
    if (!ctx.search) {
      return { ok: false, error: '联网检索未配置（缺少 FIRECRAWL_API_KEY），请改用本地知识或继续追问。' }
    }
    const outcome = await ctx.search.search(input.query)
    ctx.workspace.addSearchResult(input.query, outcome)
    return {
      ok: true,
      summary: `检索「${input.query}」：${outcome.snippets.length} 条结果，${outcome.sources.length} 个来源`,
    }
  },
}
