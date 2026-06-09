export type ScenarioKey = 'dizziness' | 'chestPain' | 'cough' | 'general'

export type QuestionOption = {
  label: string
  value: string
}

export type ConsultationQuestion = {
  key: string
  text: string
  type: 'single' | 'multi' | 'text'
  required?: boolean
  options?: QuestionOption[]
  placeholder?: string
}

export type ConsultationAnswer = {
  questionKey: string
  questionText: string
  answerValue: string | string[]
  answerText: string
}

export type Direction = {
  title: string
  support: string[]
  caution: string[]
}

export type RuleResult = {
  urgencyLevel: 'A' | 'B' | 'C' | 'D'
  riskLevel: 'high' | 'medium' | 'low'
  urgencyTitle: string
  urgencyAdvice: string
  possibleDirections: Direction[]
  departmentSuggestion: string
  dailyAdvice: string[]
  uncertaintyItems: string[]
  doctorSummary: string
}

type ScenarioConfig = {
  key: ScenarioKey
  name: string
  match: RegExp
  questions: ConsultationQuestion[]
}

const sharedQuestions: ConsultationQuestion[] = [
  {
    key: 'patient',
    text: '这次不舒服的人是谁？',
    type: 'single',
    required: true,
    options: [
      { label: '本人', value: 'self' },
      { label: '家人', value: 'family' },
      { label: '不清楚', value: 'unknown' },
    ],
  },
  {
    key: 'age',
    text: '大概多大年纪？',
    type: 'text',
    required: true,
    placeholder: '例如：68 岁，或 55 岁以上',
  },
]

export const scenarios: ScenarioConfig[] = [
  {
    key: 'dizziness',
    name: '头晕',
    match: /(头晕|眩晕|发晕|晕倒|站不稳)/,
    questions: [
      ...sharedQuestions,
      {
        key: 'duration',
        text: '头晕从什么时候开始，持续多久了？',
        type: 'single',
        required: true,
        options: [
          { label: '刚刚突然出现', value: 'sudden' },
          { label: '1-3 天', value: 'days' },
          { label: '超过 1 周', value: 'week' },
          { label: '反复很久', value: 'chronic' },
          { label: '不清楚', value: 'unknown' },
        ],
      },
      {
        key: 'dizziness_red_flags',
        text: '有没有下面这些情况？',
        type: 'multi',
        required: true,
        options: [
          { label: '一侧肢体无力', value: 'limb_weakness' },
          { label: '说话不清或口角歪斜', value: 'speech_or_face' },
          { label: '胸闷胸痛', value: 'chest_pain' },
          { label: '突发剧烈头痛', value: 'severe_headache' },
          { label: '都没有', value: 'none' },
          { label: '不清楚', value: 'unknown' },
        ],
      },
      {
        key: 'severity',
        text: '这次不适程度大概怎样？',
        type: 'single',
        required: true,
        options: [
          { label: '轻微，可以正常活动', value: 'mild' },
          { label: '中等，需要休息', value: 'moderate' },
          { label: '严重，明显影响行动', value: 'severe' },
          { label: '不清楚', value: 'unknown' },
        ],
      },
      {
        key: 'history',
        text: '是否有高血压、糖尿病、心脏病或脑血管病史？',
        type: 'text',
        placeholder: '没有也可以填“无”',
      },
      {
        key: 'medication',
        text: '目前有没有正在吃什么药？',
        type: 'text',
        placeholder: '没有也可以填“无”',
      },
    ],
  },
  {
    key: 'chestPain',
    name: '胸痛/胸闷',
    match: /(胸痛|胸口痛|胸闷|心口痛|胸口闷)/,
    questions: [
      ...sharedQuestions,
      {
        key: 'duration',
        text: '胸痛或胸闷持续了多久？',
        type: 'single',
        required: true,
        options: [
          { label: '超过 10 分钟仍不缓解', value: 'over_10_min' },
          { label: '几分钟后缓解', value: 'minutes' },
          { label: '反复发作', value: 'recurrent' },
          { label: '不清楚', value: 'unknown' },
        ],
      },
      {
        key: 'chest_red_flags',
        text: '有没有伴随这些情况？',
        type: 'multi',
        required: true,
        options: [
          { label: '呼吸困难', value: 'breathing_difficulty' },
          { label: '出冷汗或明显乏力', value: 'sweating' },
          { label: '疼痛放射到左臂/后背/下颌', value: 'radiating_pain' },
          { label: '晕厥或快要晕倒', value: 'fainting' },
          { label: '都没有', value: 'none' },
          { label: '不清楚', value: 'unknown' },
        ],
      },
      {
        key: 'pain_type',
        text: '疼痛更像哪一种？',
        type: 'single',
        options: [
          { label: '压榨样或闷压感', value: 'pressure' },
          { label: '针刺样', value: 'stabbing' },
          { label: '烧灼感', value: 'burning' },
          { label: '说不清', value: 'unknown' },
        ],
      },
      {
        key: 'history',
        text: '是否有高血压、冠心病、糖尿病或吸烟史？',
        type: 'text',
        placeholder: '例如：高血压 10 年；不清楚也可以说明',
      },
      {
        key: 'medication',
        text: '目前有没有正在吃什么药？',
        type: 'text',
        placeholder: '没有也可以填“无”',
      },
    ],
  },
  {
    key: 'cough',
    name: '咳嗽',
    match: /(咳嗽|咳|痰|喉咙痒)/,
    questions: [
      ...sharedQuestions,
      {
        key: 'duration',
        text: '咳嗽持续多久了？',
        type: 'single',
        required: true,
        options: [
          { label: '3 天以内', value: 'short' },
          { label: '3-14 天', value: 'two_weeks' },
          { label: '超过 2 周', value: 'over_two_weeks' },
          { label: '反复很久', value: 'chronic' },
          { label: '不清楚', value: 'unknown' },
        ],
      },
      {
        key: 'cough_red_flags',
        text: '有没有这些需要尽快处理的情况？',
        type: 'multi',
        required: true,
        options: [
          { label: '呼吸困难', value: 'breathing_difficulty' },
          { label: '咳血', value: 'bloody_sputum' },
          { label: '持续高热或精神很差', value: 'high_fever' },
          { label: '明显胸痛', value: 'chest_pain' },
          { label: '都没有', value: 'none' },
          { label: '不清楚', value: 'unknown' },
        ],
      },
      {
        key: 'sputum',
        text: '有没有痰、发热、咽痛或鼻塞？',
        type: 'text',
        placeholder: '例如：有黄痰，低热，晚上咳得多',
      },
      {
        key: 'history',
        text: '是否有哮喘、慢阻肺或过敏史？',
        type: 'text',
        placeholder: '没有也可以填“无”',
      },
      {
        key: 'medication',
        text: '目前有没有正在吃什么药？',
        type: 'text',
        placeholder: '没有也可以填“无”',
      },
    ],
  },
  {
    key: 'general',
    name: '综合健康咨询',
    match: /.*/,
    questions: [
      ...sharedQuestions,
      {
        key: 'duration',
        text: '这个情况大概出现多久了？',
        type: 'single',
        required: true,
        options: [
          { label: '刚出现不久（不到1天）', value: 'less_than_day' },
          { label: '几天了', value: 'few_days' },
          { label: '超过 1 周', value: 'over_week' },
          { label: '反复很久了', value: 'chronic' },
          { label: '不清楚', value: 'unknown' },
        ],
      },
      {
        key: 'general_red_flags',
        text: '有没有伴随以下任何一种危险情况？',
        type: 'multi',
        required: true,
        options: [
          { label: '呼吸困难或喘不上气', value: 'breathing_difficulty' },
          { label: '突发剧烈胸痛', value: 'chest_pain' },
          { label: '意识模糊或晕倒', value: 'fainting' },
          { label: '说话不清或一侧肢体无力', value: 'limb_weakness' },
          { label: '大量出血、呕血或黑便', value: 'severe_bleeding' },
          { label: '都没有', value: 'none' },
          { label: '不清楚', value: 'unknown' },
        ],
      },
      {
        key: 'other_symptoms',
        text: '除了刚才说的，还有其他不舒服吗？',
        type: 'text',
        placeholder: '例如：发烧、恶心、哪里痛',
      },
      {
        key: 'history',
        text: '以前有没有高血压、糖尿病、心脏病等基础病？',
        type: 'text',
        placeholder: '没有也可以填“无”',
      },
      {
        key: 'medication',
        text: '目前有没有正在吃什么药？',
        type: 'text',
        placeholder: '没有也可以填“无”',
      },
    ],
  },
]

export function identifyScenario(input: string): ScenarioConfig {
  return scenarios.find((scenario) => scenario.key !== 'general' && scenario.match.test(input)) ?? scenarios.find(s => s.key === 'general')!
}

export function getScenario(key: string): ScenarioConfig | undefined {
  return scenarios.find((scenario) => scenario.key === key)
}

export function buildResult(
  chiefComplaint: string,
  scenarioKey: ScenarioKey,
  answers: ConsultationAnswer[],
): RuleResult {
  const hasAny = (...values: string[]) =>
    answers.some((answer) => {
      const raw = answer.answerValue
      const list = Array.isArray(raw) ? raw : [raw]
      return values.some((value) => list.includes(value))
    })

  const hasRedFlag = hasAny(
    'limb_weakness',
    'speech_or_face',
    'severe_headache',
    'breathing_difficulty',
    'sweating',
    'radiating_pain',
    'fainting',
    'bloody_sputum',
    'high_fever',
    'chest_pain',
    'severe_bleeding'
  )

  let urgencyLevel: RuleResult['urgencyLevel'] = 'C'
  let riskLevel: RuleResult['riskLevel'] = 'low'
  let urgencyTitle = '建议门诊评估'
  let urgencyAdvice = '目前信息未提示必须立即急诊，但仍建议结合症状变化预约相关科室门诊。'

  if (hasRedFlag || (scenarioKey === 'chestPain' && hasAny('over_10_min'))) {
    urgencyLevel = 'A'
    riskLevel = 'high'
    urgencyTitle = '建议立即就医或联系急救'
    urgencyAdvice = '存在红旗信号或胸痛高危特征，应优先线下急诊评估，不建议继续在家观察。'
  } else if (hasAny('severe', 'recurrent', 'over_two_weeks', 'chronic')) {
    urgencyLevel = 'B'
    riskLevel = 'medium'
    urgencyTitle = '建议尽快就医'
    urgencyAdvice = '症状持续、反复或影响日常活动，建议 24-48 小时内就医评估。'
  } else if (scenarioKey === 'cough' && hasAny('short', 'two_weeks')) {
    urgencyLevel = 'D'
    riskLevel = 'low'
    urgencyTitle = '可先观察变化'
    urgencyAdvice = '暂无明显高危信号时，可观察体温、呼吸、痰色和持续时间；加重时及时就医。'
  }

  const scenarioResult = buildScenarioSpecificResult(scenarioKey)
  const doctorSummary = buildDoctorSummary(chiefComplaint, scenarioKey, answers, urgencyTitle)

  return {
    urgencyLevel,
    riskLevel,
    urgencyTitle,
    urgencyAdvice,
    possibleDirections: scenarioResult.possibleDirections,
    departmentSuggestion: urgencyLevel === 'A' ? '急诊科' : scenarioResult.departmentSuggestion,
    dailyAdvice: scenarioResult.dailyAdvice,
    uncertaintyItems: [
      '线上规则原型不能替代医生面诊，也不能给出确诊。',
      '若症状加重、出现新的红旗信号，需及时线下就医。',
      ...scenarioResult.uncertaintyItems,
    ],
    doctorSummary,
  }
}

function buildScenarioSpecificResult(scenarioKey: ScenarioKey) {
  if (scenarioKey === 'chestPain') {
    return {
      departmentSuggestion: '急诊科、心血管内科',
      possibleDirections: [
        {
          title: '心血管相关风险需优先排查',
          support: ['主诉涉及胸痛或胸闷', '胸痛场景需要优先识别呼吸困难、出汗、放射痛等红旗信号'],
          caution: ['仅凭线上描述不能判断是否为心肌缺血或其他急症'],
        },
        {
          title: '也可能与呼吸、消化或肌肉骨骼因素相关',
          support: ['疼痛性质、持续时间和诱因会影响方向判断'],
          caution: ['有高危伴随症状时不应按普通不适处理'],
        },
      ],
      dailyAdvice: ['停止剧烈活动并保持有人陪同', '不要自行加减心血管药物', '记录发作时间、持续多久、诱因和缓解方式'],
      uncertaintyItems: ['需要血压、心电图、心肌酶等线下检查信息才能进一步判断。'],
    }
  }

  if (scenarioKey === 'cough') {
    return {
      departmentSuggestion: '呼吸内科、全科医学科',
      possibleDirections: [
        {
          title: '常见呼吸道感染或气道刺激',
          support: ['咳嗽持续时间、发热、痰色和咽鼻症状是重要线索'],
          caution: ['持续高热、呼吸困难、咳血需要尽快就医'],
        },
        {
          title: '过敏、哮喘或慢性气道问题',
          support: ['反复咳嗽、夜间明显或有过敏史时需要考虑'],
          caution: ['长期咳嗽需要线下评估，不建议仅靠止咳药处理'],
        },
      ],
      dailyAdvice: ['观察体温、呼吸频率和痰色变化', '多饮水、避免烟雾和冷空气刺激', '不要自行长期使用抗生素或强力止咳药'],
      uncertaintyItems: ['缺少听诊、血氧、胸片或感染指标时，不能确认病因。'],
    }
  }

  if (scenarioKey === 'general') {
    return {
      departmentSuggestion: '全科医学科、急诊科（视红旗信号而定）',
      possibleDirections: [
        {
          title: '系统性疾病排查',
          support: ['主诉未明确归类为头晕、胸痛或咳嗽', '需要结合伴随症状进一步评估'],
          caution: ['出现任何红旗信号需优先就医'],
        },
        {
          title: '常见健康问题或自限性不适',
          support: ['如果症状轻微且短期内无明显进展'],
          caution: ['线上规则仅作为信息整理辅助'],
        },
      ],
      dailyAdvice: ['注意休息并观察症状演变', '记录症状出现的时间和诱发因素', '不要自行盲目服药'],
      uncertaintyItems: ['因为症状不够具体或多变，线上无法给出明确方向，必须结合医生查体。'],
    }
  }

  return {
    departmentSuggestion: '神经内科、全科医学科；伴胸闷胸痛时优先急诊',
    possibleDirections: [
      {
        title: '血压波动、前庭或脑血管风险需要区分',
        support: ['头晕需要结合年龄、起病方式、持续时间和伴随症状判断'],
        caution: ['突发肢体无力、说话不清、口角歪斜时需急诊评估'],
      },
      {
        title: '疲劳、睡眠、用药或耳源性眩晕也可能相关',
        support: ['反复或体位变化明显时需要补充发作特点'],
        caution: ['线上规则只能整理信息，不能判断具体疾病'],
      },
    ],
    dailyAdvice: ['先坐下或躺下，避免独自上下楼和开车', '记录血压、脉搏、发作时间和诱因', '若出现神经系统红旗信号，立即就医'],
    uncertaintyItems: ['缺少血压、神经系统查体和耳鼻喉评估，方向仍不确定。'],
  }
}

function buildDoctorSummary(
  chiefComplaint: string,
  scenarioKey: ScenarioKey,
  answers: ConsultationAnswer[],
  urgencyTitle: string,
) {
  const scenario = getScenario(scenarioKey)
  const lines = [
    '就诊前病情摘要',
    '',
    `主要不适：${chiefComplaint}`,
    `咨询场景：${scenario?.name ?? '常见症状'}`,
    `风险提示：${urgencyTitle}`,
  ]

  for (const answer of answers) {
    lines.push(`${answer.questionText}：${answer.answerText || '未说明'}`)
  }

  lines.push('')
  lines.push('需要医生重点评估：症状严重程度、红旗信号、既往病史、当前用药，以及是否需要进一步检查。')
  lines.push('说明：以上为就医前信息整理，不是确诊结论。')

  return lines.join('\n')
}
