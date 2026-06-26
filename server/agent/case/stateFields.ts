// CaseState 字段工具：路径取值 + 内部字段名 -> 用户可读描述
// 内部 schema 字段名（symptoms.severity 等）不允许直接出现在用户可见文案中。

import type { CaseState } from './CaseState.ts'

/** 症状字段的用户可读名称 */
export const SYMPTOM_FIELD_LABELS: Record<string, string> = {
  chiefComplaint: '主要不适',
  onsetTime: '出现时间',
  duration: '持续时间',
  location: '具体位置',
  severity: '疼痛/不适的强度',
  frequency: '发作频率',
  painQuality: '疼痛性质',
  onsetPattern: '发作方式（突发还是逐渐）',
  triggers: '诱因（活动、情绪、进食等）',
  relievingFactors: '缓解方式（休息、按压、体位等）',
  associatedSymptoms: '伴随症状（出汗、恶心、气短等）',
  negativeSymptoms: '已排除的症状',
  progression: '变化趋势（加重还是缓解）',
}

const PROFILE_FIELD_LABELS: Record<string, string> = {
  age: '年龄',
  sex: '性别',
  pregnancy: '是否怀孕',
  chronicDiseases: '既往慢性病',
  currentMedications: '当前用药',
  allergies: '过敏史',
}

/** 把 "symptoms.severity" / "userProfile.age" 这类内部路径转成用户可读描述 */
export function humanizeFieldPath(path: string): string {
  const segments = path.split('.')
  const last = segments[segments.length - 1]
  if (segments[0] === 'userProfile' || PROFILE_FIELD_LABELS[last]) {
    return PROFILE_FIELD_LABELS[last] ?? last
  }
  return SYMPTOM_FIELD_LABELS[last] ?? last
}

/** 按路径取值，用于 Trace 中的字段级 diff（state_change） */
export function getByPath(state: unknown, path: string): unknown {
  let current: unknown = state
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** 按路径判断字段是否已有有效值（空字符串/空数组视为无值） */
export function fieldHasValue(state: CaseState, path: string): boolean {
  let current: unknown = state
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return false
    current = (current as Record<string, unknown>)[segment]
  }
  if (current === undefined || current === null) return false
  if (typeof current === 'string') return current.trim().length > 0
  if (Array.isArray(current)) return current.length > 0
  return true
}

/** 用户可读的已知信息清单（用于阶段报告 / 流式过程展示） */
export function buildKnownFacts(state: CaseState): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = []
  const profile = state.userProfile
  const s = state.symptoms

  if (profile.age !== undefined) facts.push({ label: '年龄', value: `${profile.age}岁` })
  if (profile.sex && profile.sex !== 'unknown') facts.push({ label: '性别', value: profile.sex === 'male' ? '男' : '女' })
  if (s.chiefComplaint) facts.push({ label: '主诉', value: s.chiefComplaint })
  if (s.painQuality) facts.push({ label: '性质', value: s.painQuality })
  if (s.location) facts.push({ label: '部位', value: s.location })
  if (s.onsetTime) facts.push({ label: '出现时间', value: s.onsetTime })
  if (s.duration) facts.push({ label: '持续时间', value: s.duration })
  if (s.frequency) facts.push({ label: '发作频率', value: s.frequency })
  if (s.severity) facts.push({ label: '严重程度', value: s.severity })
  if (s.onsetPattern) facts.push({ label: '发作方式', value: s.onsetPattern })
  if (s.triggers?.length) facts.push({ label: '诱因', value: s.triggers.join('、') })
  if (s.associatedSymptoms?.length) facts.push({ label: '伴随', value: s.associatedSymptoms.join('、') })
  if (s.relievingFactors?.length) facts.push({ label: '缓解方式', value: s.relievingFactors.join('、') })
  if (s.negativeSymptoms?.length) facts.push({ label: '已确认没有', value: s.negativeSymptoms.join('、') })
  if (profile.chronicDiseases?.length) facts.push({ label: '既往病史', value: profile.chronicDiseases.join('、') })
  if (profile.currentMedications?.length) facts.push({ label: '当前用药', value: profile.currentMedications.join('、') })

  return facts
}

/** 仍未确认的关键信息（人类可读，已过滤掉实际已有值的字段） */
export function buildUnconfirmedLabels(state: CaseState, fieldPaths: string[]): string[] {
  return fieldPaths
    .filter((path) => !fieldHasValue(state, path))
    .map((path) => humanizeFieldPath(path))
}
