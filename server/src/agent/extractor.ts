// 从自然语言抽取结构化信息（extract_facts 的底层）。
// RuleExtractor：确定性规则抽取（症状同义词 + 年龄/性别/时长正则），作为默认与降级路径。
// 设计文档把 extract_facts 列为工具；真实 LLM 抽取可实现同一 Extractor 接口注入替换。

import type { ExtractedFacts } from '../schemas/index.ts'
import type { Knowledge } from '../knowledge/loader.ts'

export interface Extractor {
  extract(text: string): ExtractedFacts | Promise<ExtractedFacts>
}

const CN_NUM: Record<string, number> = {
  零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5,
}

function parseAge(text: string): number | undefined {
  const m = /(\d{1,3})\s*岁/.exec(text)
  if (m) {
    const age = Number(m[1])
    if (age > 0 && age < 130) return age
  }
  return undefined
}

function parseSex(text: string): 'male' | 'female' | undefined {
  // 先排除否定/无关，简单按出现判断；女优先于男以处理「女儿」类（仍属粗粒度，LLM 抽取更准）。
  if (/女(性|士|生|孩|人)?/.test(text)) return 'female'
  if (/男(性|士|生|孩|人)?/.test(text)) return 'male'
  return undefined
}

function parseDuration(text: string): string | undefined {
  const m = /(半|[一二两三四五六七八九十\d]+)\s*(分钟|小时|天|周|星期|个月|月|年)/.exec(text)
  return m ? m[0] : undefined
}

function numFromToken(token: string): number | undefined {
  if (/^\d+$/.test(token)) return Number(token)
  if (token.length === 1 && token in CN_NUM) return CN_NUM[token]
  return undefined
}

/** 规则抽取：稳定、不触网，作为默认与 LLM 不可用时的降级。 */
export class RuleExtractor implements Extractor {
  constructor(private readonly knowledge: Knowledge) {}

  extract(text: string): ExtractedFacts {
    const facts: Record<string, string> = {}
    const duration = parseDuration(text)
    if (duration) {
      facts.duration = duration
      const token = /(半|[一二两三四五六七八九十\d]+)/.exec(duration)?.[1]
      if (token) {
        const n = numFromToken(token)
        if (n !== undefined) facts.durationValue = String(n)
      }
    }
    return {
      symptoms: this.knowledge.matchSymptoms(text),
      age: parseAge(text),
      sex: parseSex(text),
      facts,
    }
  }
}
