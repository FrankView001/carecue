// extract_facts：从自然语言抽取症状/年龄/性别/时长等结构化信息，写回 Workspace。
// 替代 M1/M2 主循环里的 naive 种子；由 requiredAction 在每轮开头强制执行。

import { z } from 'zod'
import { ExtractFactsInput } from '../schemas/index.ts'
import type { Tool } from './types.ts'

type Input = z.infer<typeof ExtractFactsInput>

export const extractFactsTool: Tool<Input> = {
  name: 'extract_facts',
  description: '从用户的自然语言描述中抽取结构化信息（症状、年龄、性别、持续时间等）。',
  inputSchema: ExtractFactsInput,
  spec: {
    name: 'extract_facts',
    description: '从自然语言抽取结构化信息（症状、年龄、性别、持续时间）。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '用户原始描述' } },
      required: ['text'],
    },
  },
  async run(input, ctx) {
    const extracted = await ctx.extractor.extract(input.text)
    ctx.workspace.applyFacts(extracted)
    ctx.workspace.lastExtractedMessage = input.text
    const parts = [`症状=${extracted.symptoms.join('、') || '无'}`]
    if (extracted.age !== undefined) parts.push(`年龄=${extracted.age}`)
    if (extracted.sex) parts.push(`性别=${extracted.sex}`)
    if (extracted.facts.duration) parts.push(`时长=${extracted.facts.duration}`)
    return { ok: true, summary: `抽取：${parts.join('，')}` }
  },
}
