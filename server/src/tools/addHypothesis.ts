// add_hypothesis：添加一个鉴别假设（初始权重 0.5）。

import { z } from 'zod'
import { AddHypothesisInput } from '../schemas/index.ts'
import type { Tool } from './types.ts'

type Input = z.infer<typeof AddHypothesisInput>

export const addHypothesisTool: Tool<Input> = {
  name: 'add_hypothesis',
  description: '添加一个鉴别假设（可能的方向），初始权重中性，便于后续追问/搜索逐步加权。',
  inputSchema: AddHypothesisInput,
  spec: {
    name: 'add_hypothesis',
    description: '添加一个鉴别假设。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        initialEvidence: { type: 'string', description: '支持该假设的初始线索（可选）' },
      },
      required: ['name'],
    },
  },
  run(input, ctx) {
    ctx.workspace.addHypothesis({
      name: input.name,
      weight: 0.5,
      supportingEvidence: input.initialEvidence ? [input.initialEvidence] : [],
      againstEvidence: [],
    })
    return { ok: true, summary: `新增假设：${input.name}` }
  },
}
