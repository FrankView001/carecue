// update_hypothesis：根据新信息调整某个假设的权重与证据。

import { z } from 'zod'
import { UpdateHypothesisInput } from '../schemas/index.ts'
import type { Tool } from './types.ts'

type Input = z.infer<typeof UpdateHypothesisInput>

export const updateHypothesisTool: Tool<Input> = {
  name: 'update_hypothesis',
  description: '根据新信息调整某个假设的权重（delta 正=更支持，负=更不支持）并记录证据。',
  inputSchema: UpdateHypothesisInput,
  spec: {
    name: 'update_hypothesis',
    description: '调整某个假设的权重与证据。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        delta: { type: 'number', description: '权重增量 [-1,1]，正=支持，负=反对' },
        evidence: { type: 'string' },
      },
      required: ['name', 'delta'],
    },
  },
  run(input, ctx) {
    const ok = ctx.workspace.updateHypothesis(input.name, input.delta, input.evidence)
    if (!ok) return { ok: false, error: `假设不存在：${input.name}` }
    return { ok: true, summary: `更新假设：${input.name} (${input.delta >= 0 ? '+' : ''}${input.delta})` }
  },
}
