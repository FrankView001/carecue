// Workspace：共享工作区。所有工具读写它，所有决策基于它（设计文档 2.3）。
// 只允许增量更新，不允许整体替换；toSummary() 生成给 LLM 看的紧凑描述。

import type { ExtractedFacts, Hypothesis, RedFlag, RedFlagStatus } from '../schemas/index.ts'
import type { RedFlagDef } from '../knowledge/loader.ts'

export interface WorkspaceSnapshot {
  caseId: string
  age?: number
  sex?: 'male' | 'female'
  symptoms: string[]
  extractedFacts: Record<string, unknown>
  redFlags: RedFlag[]
  redFlagsLoaded: boolean
  hypotheses: Hypothesis[]
  askedQuestions: string[]
  awaitingRedFlag?: string
  rounds: number
  searchResults: Record<string, unknown>
  lastExtractedMessage?: string
}

export class Workspace {
  readonly caseId: string
  age?: number
  sex?: 'male' | 'female'
  symptoms: string[] = []
  extractedFacts: Record<string, unknown> = {}
  redFlags: RedFlag[] = []
  /** 是否已对当前症状执行过 lookup_red_flags（Guard 硬约束依据）。 */
  redFlagsLoaded = false
  hypotheses: Hypothesis[] = []
  askedQuestions: string[] = []
  /** 上一轮 ask_user 指向的红旗名；用户回答后据此归位更新。 */
  awaitingRedFlag?: string
  rounds = 0
  searchResults: Record<string, unknown> = {}
  /** 本轮用户输入（供 requiredAction 判断是否已抽取）。 */
  currentMessage = ''
  /** 已抽取过的最近一条文本，避免对同一句重复 extract_facts。 */
  lastExtractedMessage?: string

  constructor(caseId: string) {
    this.caseId = caseId
  }

  // ── 增量更新 ──────────────────────────────────────────────────────────────
  addSymptom(symptom: string): void {
    if (symptom && !this.symptoms.includes(symptom)) this.symptoms.push(symptom)
  }

  /** 写入 extract_facts 的抽取结果（增量合并，不整体替换）。 */
  applyFacts(extracted: ExtractedFacts): void {
    if (extracted.age !== undefined && this.age === undefined) this.age = extracted.age
    if (extracted.sex !== undefined && this.sex === undefined) this.sex = extracted.sex
    extracted.symptoms.forEach((s) => this.addSymptom(s))
    for (const [k, v] of Object.entries(extracted.facts)) {
      if (this.extractedFacts[k] === undefined) this.extractedFacts[k] = v
    }
  }

  addSearchResult(query: string, result: unknown): void {
    this.searchResults[query] = result
  }

  /** 加载红旗：把知识库定义转为运行态 pending 条目（已存在的不覆盖状态）。 */
  loadRedFlags(defs: RedFlagDef[]): void {
    for (const def of defs) {
      if (this.redFlags.some((r) => r.name === def.name)) continue
      this.redFlags.push({
        name: def.name,
        status: 'pending',
        severity: def.severity,
        ask: def.ask,
        positiveSignals: def.positiveSignals,
      })
    }
    this.redFlagsLoaded = true
  }

  updateRedFlag(name: string, status: RedFlagStatus, evidence?: string): boolean {
    const rf = this.redFlags.find((r) => r.name === name)
    if (!rf) return false
    rf.status = status
    if (evidence) rf.evidence = evidence
    if (this.awaitingRedFlag === name) this.awaitingRedFlag = undefined
    return true
  }

  addHypothesis(h: Hypothesis): void {
    if (this.hypotheses.some((x) => x.name === h.name)) return
    this.hypotheses.push(h)
  }

  /** 调整假设权重并记录证据（delta 正=支持，负=反对）。返回是否命中已有假设。 */
  updateHypothesis(name: string, delta: number, evidence?: string): boolean {
    const h = this.hypotheses.find((x) => x.name === name)
    if (!h) return false
    h.weight = Math.min(1, Math.max(0, h.weight + delta))
    if (evidence) {
      if (delta >= 0) h.supportingEvidence.push(evidence)
      else h.againstEvidence.push(evidence)
    }
    return true
  }

  recordQuestion(question: string): void {
    if (!this.askedQuestions.includes(question)) this.askedQuestions.push(question)
  }

  hasAskedQuestion(question: string): boolean {
    return this.askedQuestions.includes(question)
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────
  pendingRedFlags(): RedFlag[] {
    return this.redFlags.filter((r) => r.status === 'pending')
  }

  positiveHighRiskRedFlag(): RedFlag | undefined {
    return this.redFlags.find((r) => r.status === 'positive' && r.severity === 'high')
  }

  /** 给 LLM 看的紧凑描述（不直接塞完整对象，控制 token）。 */
  toSummary(): string {
    const lines: string[] = []
    lines.push(`轮次: ${this.rounds}`)
    if (this.age || this.sex) lines.push(`基础: ${this.age ?? '?'}岁 ${this.sex ?? ''}`.trim())
    lines.push(`症状: ${this.symptoms.join('、') || '（未知）'}`)
    if (this.redFlags.length) {
      const rf = this.redFlags
        .map((r) => `${r.name}[${r.severity}]=${r.status}`)
        .join('; ')
      lines.push(`红旗: ${rf}`)
    } else {
      lines.push('红旗: 未加载')
    }
    if (this.awaitingRedFlag) lines.push(`待回答红旗: ${this.awaitingRedFlag}`)
    if (this.hypotheses.length) {
      lines.push(`假设: ${this.hypotheses.map((h) => `${h.name}(${h.weight})`).join('; ')}`)
    }
    if (this.askedQuestions.length) lines.push(`已问: ${this.askedQuestions.join(' | ')}`)
    return lines.join('\n')
  }

  toSnapshot(): WorkspaceSnapshot {
    return {
      caseId: this.caseId,
      age: this.age,
      sex: this.sex,
      symptoms: [...this.symptoms],
      extractedFacts: { ...this.extractedFacts },
      redFlags: this.redFlags.map((r) => ({ ...r })),
      redFlagsLoaded: this.redFlagsLoaded,
      hypotheses: this.hypotheses.map((h) => ({ ...h })),
      askedQuestions: [...this.askedQuestions],
      awaitingRedFlag: this.awaitingRedFlag,
      rounds: this.rounds,
      searchResults: { ...this.searchResults },
      lastExtractedMessage: this.lastExtractedMessage,
    }
  }

  static fromSnapshot(snap: WorkspaceSnapshot): Workspace {
    const ws = new Workspace(snap.caseId)
    ws.age = snap.age
    ws.sex = snap.sex
    ws.symptoms = [...snap.symptoms]
    ws.extractedFacts = { ...snap.extractedFacts }
    ws.redFlags = snap.redFlags.map((r) => ({ ...r }))
    ws.redFlagsLoaded = snap.redFlagsLoaded
    ws.hypotheses = snap.hypotheses.map((h) => ({ ...h }))
    ws.askedQuestions = [...snap.askedQuestions]
    ws.awaitingRedFlag = snap.awaitingRedFlag
    ws.rounds = snap.rounds
    ws.searchResults = { ...snap.searchResults }
    ws.lastExtractedMessage = snap.lastExtractedMessage
    return ws
  }
}
