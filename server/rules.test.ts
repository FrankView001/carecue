import assert from 'node:assert/strict'
import {
  assertAiOutputIsSafe,
  buildFallbackAiResult,
  mergeAiResult,
  type AiAnalysisOutput,
} from './ai-schema.ts'
import {
  buildResult,
  getScenario,
  identifyScenario,
  scenarios,
  type ConsultationAnswer,
} from './rules.ts'

type TestCase = {
  name: string
  run: () => void
}

const tests: TestCase[] = [
  {
    name: 'identifyScenario matches dizziness, chest pain, and cough inputs',
    run: () => {
      assert.equal(identifyScenario('最近总是站起来头晕').key, 'dizziness')
      assert.equal(identifyScenario('胸口闷，需要马上去医院吗？').key, 'chestPain')
      assert.equal(identifyScenario('咳嗽两周不好，要挂什么科？').key, 'cough')
    },
  },
  {
    name: 'identifyScenario falls back to general for unsupported symptoms',
    run: () => {
      assert.equal(identifyScenario('胃有点不舒服').key, 'general')
    },
  },
  {
    name: 'getScenario returns known scenarios and rejects unknown key',
    run: () => {
      assert.equal(getScenario('dizziness')?.name, '头晕')
      assert.equal(getScenario('chestPain')?.name, '胸痛/胸闷')
      assert.equal(getScenario('cough')?.name, '咳嗽')
      assert.equal(getScenario('unknown'), undefined)
    },
  },
  {
    name: 'each scenario asks shared patient and age questions first',
    run: () => {
      for (const scenario of scenarios) {
        assert.equal(scenario.questions[0]?.key, 'patient')
        assert.equal(scenario.questions[0]?.required, true)
        assert.equal(scenario.questions[1]?.key, 'age')
        assert.equal(scenario.questions[1]?.required, true)
      }
    },
  },
  {
    name: 'chest pain over ten minutes upgrades to emergency even without other red flags',
    run: () => {
      const result = buildResult('胸口闷，需要马上去医院吗？', 'chestPain', answers([
        ['duration', '胸痛或胸闷持续了多久？', 'over_10_min', '超过 10 分钟仍不缓解'],
        ['chest_red_flags', '有没有伴随这些情况？', ['none'], '都没有'],
      ]))

      assert.equal(result.urgencyLevel, 'A')
      assert.equal(result.riskLevel, 'high')
      assert.equal(result.departmentSuggestion, '急诊科')
      assert.match(result.urgencyTitle, /立即就医|急救/)
    },
  },
  {
    name: 'dizziness neurologic red flags upgrade to emergency',
    run: () => {
      const result = buildResult('老人突然头晕站不稳', 'dizziness', answers([
        ['dizziness_red_flags', '有没有下面这些情况？', ['limb_weakness'], '一侧肢体无力'],
      ]))

      assert.equal(result.urgencyLevel, 'A')
      assert.equal(result.riskLevel, 'high')
      assert.equal(result.departmentSuggestion, '急诊科')
    },
  },
  {
    name: 'cough with short duration and no red flags can be observed',
    run: () => {
      const result = buildResult('咳嗽 2 天', 'cough', answers([
        ['duration', '咳嗽持续多久了？', 'short', '3 天以内'],
        ['cough_red_flags', '有没有这些需要尽快处理的情况？', ['none'], '都没有'],
      ]))

      assert.equal(result.urgencyLevel, 'D')
      assert.equal(result.riskLevel, 'low')
      assert.match(result.urgencyTitle, /观察/)
      assert.equal(result.departmentSuggestion, '呼吸内科、全科医学科')
    },
  },
  {
    name: 'chronic cough upgrades to near-term medical evaluation',
    run: () => {
      const result = buildResult('咳嗽反复很久', 'cough', answers([
        ['duration', '咳嗽持续多久了？', 'chronic', '反复很久'],
        ['cough_red_flags', '有没有这些需要尽快处理的情况？', ['none'], '都没有'],
      ]))

      assert.equal(result.urgencyLevel, 'B')
      assert.equal(result.riskLevel, 'medium')
      assert.match(result.urgencyTitle, /尽快就医/)
    },
  },
  {
    name: 'severe dizziness upgrades to near-term medical evaluation',
    run: () => {
      const result = buildResult('最近总是头晕', 'dizziness', answers([
        ['dizziness_red_flags', '有没有下面这些情况？', ['none'], '都没有'],
        ['severity', '这次不适程度大概怎样？', 'severe', '严重，明显影响行动'],
      ]))

      assert.equal(result.urgencyLevel, 'B')
      assert.equal(result.riskLevel, 'medium')
      assert.match(result.urgencyAdvice, /24-48 小时/)
    },
  },
  {
    name: 'doctor summary keeps medical safety boundary',
    run: () => {
      const result = buildResult('咳嗽两周不好', 'cough', answers([
        ['duration', '咳嗽持续多久了？', 'two_weeks', '3-14 天'],
      ]))

      assert.match(result.doctorSummary, /就诊前病情摘要/)
      assert.match(result.doctorSummary, /不是确诊结论/)
      assert.ok(result.uncertaintyItems.some((item) => item.includes('不能替代医生面诊')))
    },
  },
  {
    name: 'AI fallback keeps rule result available when AI is disabled',
    run: () => {
      const ruleResult = buildResult('咳嗽 2 天', 'cough', answers([
        ['duration', '咳嗽持续多久了？', 'short', '3 天以内'],
        ['cough_red_flags', '有没有这些需要尽快处理的情况？', ['none'], '都没有'],
      ]))
      const result = buildFallbackAiResult(ruleResult, 'disabled', 'deepseek/deepseek-v4-pro')

      assert.equal(result.aiStatus, 'disabled')
      assert.equal(result.urgencyLevel, ruleResult.urgencyLevel)
      assert.equal(result.departmentSuggestion, ruleResult.departmentSuggestion)
      assert.ok(result.nextSteps.includes(ruleResult.urgencyAdvice))
    },
  },
  {
    name: 'AI merge cannot downgrade A level emergency department suggestion',
    run: () => {
      const ruleResult = buildResult('胸口闷，需要马上去医院吗？', 'chestPain', answers([
        ['duration', '胸痛或胸闷持续了多久？', 'over_10_min', '超过 10 分钟仍不缓解'],
        ['chest_red_flags', '有没有伴随这些情况？', ['none'], '都没有'],
      ]))
      const result = mergeAiResult(ruleResult, safeAiOutput({
        departmentSuggestion: '心血管内科门诊',
      }), 'deepseek/deepseek-v4-pro')

      assert.equal(ruleResult.urgencyLevel, 'A')
      assert.equal(result.urgencyLevel, 'A')
      assert.equal(result.departmentSuggestion, '急诊科')
    },
  },
  {
    name: 'AI safety check rejects diagnosis and prescription wording',
    run: () => {
      assert.throws(() => {
        assertAiOutputIsSafe(safeAiOutput({
          aiSummary: '根据当前信息可以确诊为某疾病。',
        }))
      }, /unsafe medical wording/)
    },
  },
]

let failed = 0
for (const test of tests) {
  try {
    test.run()
    console.log(`PASS ${test.name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${test.name}`)
    console.error(error)
  }
}

if (failed > 0) {
  throw new Error(`${failed} rule test(s) failed.`)
}

console.log(`PASS ${tests.length} rule tests`)

function answers(rows: Array<[string, string, string | string[], string]>): ConsultationAnswer[] {
  return rows.map(([questionKey, questionText, answerValue, answerText]) => ({
    questionKey,
    questionText,
    answerValue,
    answerText,
  }))
}

function safeAiOutput(overrides: Partial<AiAnalysisOutput> = {}): AiAnalysisOutput {
  return {
    aiStatus: 'success',
    aiSummary: '目前信息提示需要结合症状持续时间、伴随表现和既往病史综合判断，不能仅凭线上描述得出确诊。',
    possibleDirections: [
      {
        title: '需要优先排查的相关风险',
        support: ['主诉和持续时间提示需要进一步评估'],
        caution: ['缺少查体和必要检查信息'],
        suggestedAction: '结合风险等级安排线下评估，并记录症状变化。',
      },
      {
        title: '常见非急性因素也需结合判断',
        support: ['部分症状可能与生活方式或基础疾病有关'],
        caution: ['如果症状加重，应及时线下评估'],
        suggestedAction: '补充诱因、持续时间和伴随症状后再交由医生判断。',
      },
    ],
    missingInformation: ['既往病史', '当前用药'],
    departmentSuggestion: '全科医学科',
    nextSteps: ['记录发作时间、持续多久和伴随症状。'],
    dailyAdvice: ['避免剧烈活动，观察症状变化。'],
    uncertaintyItems: ['线上信息不能替代医生面诊、查体和必要检查。'],
    doctorSummary: '就诊前病情摘要：用户描述近期不适，已补充部分关键信息，需要医生结合查体和检查进一步评估。',
    safetyFlags: ['以上内容是就医前信息整理，不是确诊结论。'],
    ...overrides,
  }
}
