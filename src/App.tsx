import * as React from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  ClipboardList,
  Copy,
  FileText,
  HeartPulse,
  History,
  Info,
  ListChecks,
  LogOut,
  Paperclip,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Trash2,
  User,
} from 'lucide-react'
import heroImage from './assets/carecue-hero.png'
import './App.css'

const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim()
const API_BASE = configuredApiBase || '/api'

type User = {
  id: string
  phone: string | null
  email: string | null
  displayName: string
}

type Answer = {
  questionKey: string
  questionText: string
  answerValue: string | string[]
  answerText: string
}

type Direction = {
  title: string
  support: string[]
  caution: string[]
  suggestedAction?: string
}

type SourceReference = {
  title: string
  url: string
  content?: string
  sourceLevel?: 'A' | 'B' | 'C' | 'D'
}

type Result = {
  aiStatus?: 'success' | 'fallback' | 'disabled' | 'error'
  aiModel?: string
  aiSummary?: string
  urgencyLevel: 'A' | 'B' | 'C' | 'D'
  riskLevel: 'high' | 'medium' | 'low'
  urgencyTitle: string
  urgencyAdvice: string
  possibleDirections: Direction[]
  missingInformation?: string[]
  departmentSuggestion: string
  nextSteps?: string[]
  dailyAdvice: string[]
  uncertaintyItems: string[]
  doctorSummary: string
  safetyFlags?: string[]
  sourceReferences?: SourceReference[]
  webSearchUsed?: boolean
}

type AgentRiskLevel = 'R0' | 'R1' | 'R2' | 'R3'

type AgentFollowupQuestion = {
  question: string
  reason: string
  targetField: string
  priority: 'high' | 'medium' | 'low'
  type: 'risk_probe' | 'differential' | 'care_plan'
}

type AgentSnapshot = {
  chiefComplaint: string
  primaryDomain: string
  riskLevel: AgentRiskLevel
  riskReason: string
  inRiskProbe: boolean
  knownFacts: Array<{ label: string; value: string }>
  hypotheses: Array<{ name: string; likelihood: string }>
  evidenceSources: Array<{ title: string; url: string; credibility: string }>
  searchQueries: string[]
  missingInfo: string[]
}

type AgentResponse = {
  caseId: string
  riskLevel: AgentRiskLevel
  stateSnapshot: AgentSnapshot
} & (
  | { type: 'followup'; mode: 'risk_probe' | 'differential' | 'care_plan'; intro: string; questions: AgentFollowupQuestion[] }
  | { type: 'emergency'; content: string; triggeredCombination: string[]; doctorSummary: string }
  | { type: 'final_report'; rendered: string }
  | { type: 'stage_report'; content: string; reason: string; nextStepHints: string[] }
)

type AgentStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'extracted_facts'; facts: Array<{ label: string; value: string }> }
  | { type: 'risk_check'; level: AgentRiskLevel; confirmed: string[]; denied: string[]; unresolved: string[]; reason: string }
  | { type: 'search_query'; queries: string[] }
  | { type: 'search_result'; sources: Array<{ title: string; url: string; credibility: string }> }
  | { type: 'final'; response: AgentResponse; record?: ConsultationRecord }
  | { type: 'error'; message: string }

type ChatMessage = {
  role: 'assistant' | 'user'
  content: string
  kind?: 'followup' | 'emergency' | 'final_report' | 'stage_report'
  followupMode?: AgentFollowupQuestion['type']
  questions?: AgentFollowupQuestion[]
  /** 本条回复的可审计分析过程（可折叠展示） */
  process?: string[]
}

type ConsultationRecord = {
  id: string
  chiefComplaint: string
  scenario: string
  riskLevel: string
  urgencyLevel?: string
  departmentSuggestion?: string
  createdAt: string
  answers?: Answer[]
  result?: Result
}

type View = 'home' | 'auth' | 'consult' | 'aiChat' | 'history' | 'detail'
type AuthStatus = 'checking' | 'authenticated' | 'anonymous'

const examples = [
  '我爸最近总是头晕，是怎么回事？',
  '胸口闷，需要马上去医院吗？',
  '咳嗽两周不好，要挂什么科？',
]

function App() {
  const [view, setView] = React.useState<View>('home')
  const [user, setUser] = React.useState<User | null>(null)
  const [authStatus, setAuthStatus] = React.useState<AuthStatus>('checking')
  const [authMode, setAuthMode] = React.useState<'login' | 'register'>('login')
  const [account, setAccount] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [chiefComplaint, setChiefComplaint] = React.useState('')
  const urgentKeywords = ['胸痛', '呼吸困难', '晕倒', '吐血', '意识异常', '出血', '昏迷']
  const isUrgentInput = urgentKeywords.some((keyword) => chiefComplaint.includes(keyword))
  const [caseId, setCaseId] = React.useState<string | null>(null)
  const [snapshot, setSnapshot] = React.useState<AgentSnapshot | null>(null)
  const [activeRecord, setActiveRecord] = React.useState<ConsultationRecord | null>(null)
  const [records, setRecords] = React.useState<ConsultationRecord[]>([])
  const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [copyLabel, setCopyLabel] = React.useState('复制摘要')
  const [isChatting, setIsChatting] = React.useState(false)
  const [liveProcess, setLiveProcess] = React.useState<string[]>([])

  React.useEffect(() => {
    api<{ user: User }>('/auth/me')
      .then((data) => {
        setUser(data.user)
        setAuthStatus('authenticated')
      })
      .catch(() => {
        setUser(null)
        setAuthStatus('anonymous')
      })
  }, [])

  const startExperience = () => {
    setMessage('')
    if (authStatus === 'checking') {
      setMessage('正在恢复登录状态，请稍候。')
      return
    }
    setView(user ? 'consult' : 'auth')
  }

  const submitAuth = async (event: React.FormEvent) => {
    event.preventDefault()
    setMessage('')
    try {
      const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register'
      const data = await api<{ user: User }>(endpoint, {
        method: 'POST',
        body: { account, password, displayName },
      })
      setUser(data.user)
      setAuthStatus('authenticated')
      setAccount('')
      setPassword('')
      setDisplayName('')
      setView('consult')
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined)
    setUser(null)
    setAuthStatus('anonymous')
    setView('home')
    resetConsultation()
  }

  const consultAgent = async (userMessage: string, existingCaseId: string | null) => {
    const processLines: string[] = []
    setLiveProcess([])

    try {
      const data = await streamAgentConsult(
        { caseId: existingCaseId ?? undefined, message: userMessage },
        (event) => {
          const line = describeStreamEvent(event)
          if (line) {
            processLines.push(line)
            setLiveProcess([...processLines])
          }
        },
      )
      setCaseId(data.response.caseId)
      setSnapshot(data.response.stateSnapshot)
      setChatMessages((items) => [
        ...items,
        { ...agentResponseToChatMessage(data.response), process: processLines },
      ])
    } finally {
      setLiveProcess([])
    }
  }

  const startConsultation = async () => {
    if (chiefComplaint.trim().length < 2) {
      setMessage('请先用一句话描述哪里不舒服。')
      return
    }
    if (isChatting) return

    setMessage('')
    setCaseId(null)
    setSnapshot(null)
    setChatMessages([])
    setView('aiChat')

    try {
      setIsChatting(true)
      await consultAgent(chiefComplaint.trim(), null)
    } catch (error) {
      setMessage(errorMessage(error))
      setView('consult')
    } finally {
      setIsChatting(false)
    }
  }

  const sendChatMessage = async () => {
    const content = chatInput.trim()
    if (!content || isChatting) return

    setChatMessages((items) => [...items, { role: 'user', content }])
    setChatInput('')
    setMessage('')

    try {
      setIsChatting(true)
      await consultAgent(content, caseId)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setIsChatting(false)
    }
  }

  const loadHistory = async () => {
    setMessage('')
    try {
      const data = await api<{ records: ConsultationRecord[] }>('/consultations')
      setRecords(data.records)
      setView('history')
    } catch (error) {
      setMessage(errorMessage(error))
      if (!user) setView('auth')
    }
  }

  const openRecord = async (recordId: string) => {
    try {
      const data = await api<{ record: ConsultationRecord }>(`/consultations/${recordId}`)
      setActiveRecord(data.record)
      setView('detail')
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const deleteRecord = async (recordId: string) => {
    await api(`/consultations/${recordId}`, { method: 'DELETE' })
    setRecords((items) => items.filter((item) => item.id !== recordId))
  }

  const copySummary = async (summary: string) => {
    await navigator.clipboard.writeText(summary)
    setCopyLabel('已复制')
    window.setTimeout(() => setCopyLabel('复制摘要'), 1600)
  }

  const resetConsultation = () => {
    setChiefComplaint('')
    setCaseId(null)
    setSnapshot(null)
    setChatMessages([])
    setChatInput('')
    setActiveRecord(null)
  }

  return (
    <main className="app-shell">
      {view !== 'aiChat' && (
        <header className="topbar">
          <button className="brand-button" onClick={() => setView('home')} type="button">
            <span className={`brand-mark${view === 'home' ? ' brand-mark--beating' : ''}`}>
              <HeartPulse size={22} />
            </span>
            <span>
              <strong>问康</strong>
              <small>CareCue</small>
            </span>
          </button>

          <nav className="nav-actions" aria-label="主导航">
            {authStatus === 'checking' ? (
              <button className="primary-button small" disabled type="button">
                恢复登录中
              </button>
            ) : user ? (
              <>
                <button className="ghost-button" onClick={() => setView('consult')} type="button">
                  <Stethoscope size={18} />
                  新咨询
                </button>
                <button className="ghost-button" onClick={loadHistory} type="button">
                  <History size={18} />
                  历史
                </button>
                <button className="icon-button" onClick={logout} title="退出登录" type="button">
                  <LogOut size={19} />
                </button>
              </>
            ) : (
              <button className="primary-button small" onClick={startExperience} type="button">
                立即体验
                <ArrowRight size={18} />
              </button>
            )}
          </nav>
        </header>
      )}

      {view === 'aiChat' && (
        <header className="topbar">
          <div className="brand-button">
            <span className="brand-mark">
              <HeartPulse size={22} />
            </span>
            <span>
              <strong>问康</strong>
              <small>CareCue</small>
            </span>
          </div>

          <nav className="nav-actions" aria-label="主导航">
            {user ? (
              <>
                <button className="primary-button small" onClick={() => setView('consult')} type="button">
                  + 新咨询
                </button>
                <button className="ghost-button" onClick={loadHistory} type="button">
                  <History size={18} />
                  历史
                </button>
                <button className="icon-button" onClick={logout} title="退出登录" type="button">
                  <User size={19} />
                </button>
              </>
            ) : null}
          </nav>
        </header>
      )}

      {message ? <div className="toast">{message}</div> : null}

      {view === 'home' ? (
        <HomeView onStart={startExperience} />
      ) : null}

      {view === 'auth' ? (
        <section className="auth-layout">
          <div className="auth-copy">
            <ShieldCheck size={34} />
            <h1>先确认身份，再保存健康记录</h1>
            <p>登录后，咨询记录只归你本人所有，方便自己查看、家人了解，或带去医院沟通。</p>
            <div className="safety-strip">
              <AlertTriangle size={18} />
              问康不是确诊工具；出现胸痛伴呼吸困难、说话不清、肢体无力等情况，请优先线下急诊。
            </div>
          </div>
          <form className="auth-panel" onSubmit={submitAuth}>
            <div className="segmented">
              <button className={authMode === 'login' ? 'active' : ''} onClick={() => setAuthMode('login')} type="button">
                登录
              </button>
              <button className={authMode === 'register' ? 'active' : ''} onClick={() => setAuthMode('register')} type="button">
                注册
              </button>
            </div>
            <label>
              手机号或邮箱
              <input value={account} onChange={(event) => setAccount(event.target.value)} placeholder="13800000000 / name@example.com" />
            </label>
            {authMode === 'register' ? (
              <label>
                昵称
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：王阿姨" />
              </label>
            ) : null}
            <label>
              密码
              <input value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} type="password" placeholder="至少 6 位" />
            </label>
            <button className="primary-button" type="submit">
              {authMode === 'login' ? '登录并开始咨询' : '注册并开始咨询'}
              <ArrowRight size={18} />
            </button>
          </form>
        </section>
      ) : null}

      {view === 'consult' ? (
        <section className="workspace">
          <div className="workspace-header compact-header">
            <span className="eyebrow">就医前症状整理</span>
            <h1 className="consult-title">先用一句话说哪里不舒服，问康会帮你问清关键信息</h1>
            <p>先核查是否有危险信号，再整理可能方向、日常处理和就医建议。信息不足时只做阶段性整理，不给出确诊结论。</p>
          </div>

          <div className="consult-grid">
            <div className="input-panel">
              <label>
                这次想咨询什么不舒服？
                <textarea
                  value={chiefComplaint}
                  onChange={(event) => setChiefComplaint(event.target.value)}
                  placeholder="比如：我爸最近总头晕，站起来更明显。"
                  rows={3}
                />
              </label>
              <div className="example-row">
                {examples.map((example) => (
                  <button key={example} onClick={() => setChiefComplaint(example)} type="button">
                    {example}
                  </button>
                ))}
              </div>
              <button className="primary-button" disabled={isChatting} onClick={startConsultation} type="button">
                {isChatting ? '正在整理' : '开始说明症状'}
                <ArrowRight size={18} />
              </button>
            </div>
            <aside className={`urgent-panel ${isUrgentInput ? 'urgent-active' : 'urgent-default'}`}>
              {isUrgentInput ? <AlertTriangle size={24} /> : <Info size={24} />}
              <h2>{isUrgentInput ? '紧急情况优先线下处理' : '安全提醒'}</h2>
              <p>出现胸痛伴呼吸困难、突发剧烈头痛、一侧肢体无力、意识模糊、大量出血或严重过敏等情况，不建议等待线上整理结果，请优先线下急诊。</p>
            </aside>
          </div>
        </section>
      ) : null}

      {view === 'aiChat' ? (
        <ChatView
          chatInput={chatInput}
          chatMessages={chatMessages}
          chiefComplaint={chiefComplaint}
          isChatting={isChatting}
          liveProcess={liveProcess}
          onBack={() => setView('consult')}
          onInputChange={setChatInput}
          onSend={sendChatMessage}
          snapshot={snapshot}
        />
      ) : null}

      {view === 'history' ? (
        <section className="workspace">
          <div className="workspace-header compact-header">
            <span className="eyebrow">历史记录</span>
            <h1>已保存的完整整理报告</h1>
            <p className="history-note">仅「症状处理报告」或「急症提醒」会保存；对话中的阶段性整理不会出现在这里。</p>
          </div>
          <div className="history-list">
            {records.length ? records.map((record) => (
              <article className="record-row" key={record.id}>
                <button onClick={() => openRecord(record.id)} type="button">
                  <strong>{record.chiefComplaint}</strong>
                  <span>{formatDate(record.createdAt)} · 风险：{record.urgencyLevel ?? record.riskLevel} · {record.departmentSuggestion ?? '待查看详情'}</span>
                </button>
                <button className="icon-button danger" onClick={() => deleteRecord(record.id)} title="删除记录" type="button">
                  <Trash2 size={18} />
                </button>
              </article>
            )) : (
              <div className="empty-state">暂无已保存报告。完成一次咨询并生成完整报告后，会显示在这里。</div>
            )}
          </div>
        </section>
      ) : null}

      {view === 'detail' && activeRecord?.result ? (
        <ResultView
          record={activeRecord}
          result={activeRecord.result}
          copyLabel={copyLabel}
          onCopy={copySummary}
          onNew={() => {
            resetConsultation()
            setView('consult')
          }}
          onHistory={loadHistory}
        />
      ) : null}
    </main>
  )
}

function HomeView({ onStart }: { onStart: () => void }) {
  return (
    <>
      <section className="hero-section">
        <img className="hero-image" src={heroImage} alt="家人在桌边整理就医前健康信息" />
        <div className="hero-shade" />
        <div className="hero-copy">
          <span className="eyebrow">
            <ShieldCheck size={18} />
            就医前症状整理与日常健康咨询助手
          </span>
          <h1>就医前，先把症状说清楚</h1>
          <p>通过对话整理症状、核查危险信号和医生沟通摘要，帮助长辈和家人把零散描述变成可就医、可转发、可保存的信息。</p>
          <div className="hero-actions">
            <button className="primary-button" onClick={onStart} type="button">
              立即体验
              <ArrowRight size={20} />
            </button>
            <a className="secondary-button" href="#boundary">
              先看安全边界
            </a>
          </div>
          <div className="hero-note">
            <AlertTriangle size={18} />
            问康不是确诊工具，不替代医生开药、停药或调整剂量。出现高危症状时应立即联系急救或线下就医。
          </div>
        </div>
      </section>

      <section className="method-band">
        <article>
          <ClipboardList size={26} />
          <h2>说清楚症状</h2>
          <p>用对话补齐年龄、时间、程度、伴随症状、病史和用药，不用写长文。</p>
        </article>
        <article>
          <ShieldCheck size={26} />
          <h2>核查危险信号</h2>
          <p>优先确认是否有需要急诊的情况，再查阅权威资料整理可能方向（不确诊）。</p>
        </article>
        <article>
          <FileText size={26} />
          <h2>给出可执行建议</h2>
          <p>整理日常处理、就医时机和医生沟通摘要，方便转发给家人或带去医院。</p>
        </article>

        <footer className="method-band-footer" id="boundary">
          <div className="method-band-footer-head">
            <span className="method-band-footer-label">安全边界</span>
            <p className="method-band-footer-lead">就医前整理，不作确诊结论</p>
          </div>
          <ul className="method-band-footer-list">
            <li>
              <ShieldCheck size={18} aria-hidden />
              <span>提供可能方向与阶段性判断，不替代医生面诊与必要检查。</span>
            </li>
            <li>
              <AlertTriangle size={18} aria-hidden />
              <span>胸痛、呼吸困难、言语异常、肢体无力等危险信号将优先提示就医。</span>
            </li>
            <li>
              <ListChecks size={18} aria-hidden />
              <span>建议附有依据说明、不确定项及线下就诊指引。</span>
            </li>
          </ul>
        </footer>
      </section>
    </>
  )
}

const DOMAIN_LABELS: Record<string, string> = {
  throat_respiratory: '咽喉与呼吸不适',
  gastrointestinal: '胃肠不适',
  eye_discomfort: '眼部不适',
  skin_mild: '皮肤轻微问题',
  chest_pain: '胸痛胸闷',
  headache: '头晕头痛',
  limb_pain: '肢体疼痛',
  fever: '发热相关',
  general_discomfort: '全身不适',
  unknown: '症状咨询',
}

const RISK_LABELS: Record<AgentRiskLevel, string> = {
  R0: '暂未发现明显危险信号',
  R1: '低风险，可先观察并继续补充信息',
  R2: '中风险，建议尽快就医评估',
  R3: '高风险，优先急诊或急救',
}

const FOLLOWUP_MODE_TITLES: Record<AgentFollowupQuestion['type'], string> = {
  risk_probe: '问康 · 危险信号核查',
  differential: '问康 · 补充关键信息',
  care_plan: '问康 · 日常处理相关',
}

const LIKELIHOOD_LABELS: Record<string, string> = {
  more_likely: '更像',
  possible: '也可能',
  less_likely: '暂不太支持',
  must_rule_out: '需优先排除',
}

const MESSAGE_KIND_TITLES: Record<NonNullable<ChatMessage['kind']>, string> = {
  followup: '问康 · 补充信息',
  emergency: '急症提醒',
  final_report: '症状处理报告',
  stage_report: '阶段性整理（非最终结论）',
}

function formatDomainLabel(domain?: string) {
  if (!domain) return '症状咨询'
  return DOMAIN_LABELS[domain] ?? '症状咨询'
}

function assistantMessageTitle(message: ChatMessage) {
  if (message.role !== 'assistant') return '补充说明'
  if (message.kind === 'followup') {
    const mode = message.followupMode ?? message.questions?.[0]?.type
    if (mode) return FOLLOWUP_MODE_TITLES[mode]
  }
  if (message.kind) return MESSAGE_KIND_TITLES[message.kind]
  return '问康'
}

function ChatView({
  chatInput,
  chatMessages,
  chiefComplaint,
  isChatting,
  liveProcess,
  onBack,
  onInputChange,
  onSend,
  snapshot,
}: {
  chatInput: string
  chatMessages: ChatMessage[]
  chiefComplaint: string
  isChatting: boolean
  liveProcess: string[]
  onBack: () => void
  onInputChange: (value: string) => void
  onSend: () => void
  snapshot: AgentSnapshot | null
}) {
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onSend()
  }

  return (
    <section className="chat-layout-redesigned">
      <div className="chat-main-col">
        <div className="chat-panel-header-redesigned">
          <button className="ghost-button" onClick={onBack} type="button">
            <ArrowLeft size={18} />
            返回
          </button>
          <h2>{formatDomainLabel(snapshot?.primaryDomain)}</h2>
          <div className="spacer"></div>
        </div>

        <div className="chat-cards-container">
          <div className="chat-card complaint-card">
            <div className="card-icon"><User size={28} /></div>
            <div className="card-content">
              <h3>主要诉求</h3>
              <p>我本次的主要不适是：{chiefComplaint}</p>
            </div>
            <div className="card-decoration"><HeartPulse size={80} /></div>
          </div>

          {chatMessages.map((item, index) => (
            <div className={`chat-card message-card ${item.role} ${item.kind === 'emergency' ? 'emergency-card' : ''}`} key={index}>
              <div className={`card-icon ${item.role === 'assistant' ? 'ai-icon' : ''}`}>
                {item.role === 'assistant'
                  ? (item.kind === 'emergency' ? <AlertTriangle size={28} /> : <Bot size={28} />)
                  : <User size={28} />}
              </div>
              <div className="card-content">
                <h3>{item.role === 'assistant' ? assistantMessageTitle(item) : '你的补充'}</h3>
                {item.process?.length ? (
                  <details className="process-disclosure">
                    <summary>分析过程（{item.process.length} 步）</summary>
                    <ul>
                      {item.process.map((step, stepIndex) => (
                        <li key={stepIndex}>{step}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <p className="prewrap">{item.content}</p>
                {item.questions?.length ? (
                  <ol className="followup-question-list">
                    {item.questions.map((question) => (
                      <li key={question.question}>{question.question}</li>
                    ))}
                  </ol>
                ) : null}
              </div>
            </div>
          ))}

          {isChatting ? (
            <div className="chat-card message-card assistant">
               <div className="card-icon ai-icon"><Bot size={28} /></div>
               <div className="card-content">
                 <h3>问康 · 正在整理</h3>
                 {liveProcess.length > 0 ? (
                   <ul className="live-process-list">
                     {liveProcess.map((step, stepIndex) => (
                       <li key={stepIndex} className={stepIndex === liveProcess.length - 1 ? 'active' : ''}>
                         {step}
                       </li>
                     ))}
                   </ul>
                 ) : (
                   <p>正在整理症状并核查风险信号，请稍候...</p>
                 )}
               </div>
            </div>
          ) : null}
        </div>

        <form className="chat-input-row-redesigned" onSubmit={handleSubmit}>
          <div className="attachment-icon"><Paperclip size={20} /></div>
          <textarea
            value={chatInput}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="回答上面的问题，或继续补充症状、病史、用药等"
            rows={1}
          />
          <button className="primary-button send-btn" disabled={!chatInput.trim() || isChatting} type="submit" aria-label="发送">
            <Send size={18} />
          </button>
        </form>

        <div className="chat-actions-redesigned">
          <p>
            <Info size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
            信息足够时会自动生成可带去医院整理的症状处理报告；以上内容均非确诊结论。
          </p>
        </div>
      </div>

      <aside className="chat-sidebar-col">
        {snapshot?.knownFacts.length ? (
          <div className="overview-card">
            <div className="overview-header">
              <ClipboardList size={20} />
              <h3>已确认的信息</h3>
            </div>
            <div className="known-facts-list">
              {snapshot.knownFacts.map((fact) => (
                <div className="known-fact-row" key={fact.label}>
                  <span className="fact-label">{fact.label}</span>
                  <span className="fact-value">{fact.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="overview-card">
          <div className="overview-header">
            <ShieldCheck size={20} />
            <h3>当前评估</h3>
          </div>
          <div className="overview-list">
            <div className="overview-item">
              <div className="item-icon"><AlertTriangle size={18} /></div>
              <div className="item-content">
                <span className="item-label">风险等级</span>
                <span className="item-value">{snapshot ? RISK_LABELS[snapshot.riskLevel] : '评估中'}</span>
              </div>
            </div>
            <div className="overview-item">
              <div className="item-icon"><Info size={18} /></div>
              <div className="item-content">
                <span className="item-label">评估说明</span>
                <span className="item-value">{snapshot?.riskReason || '正在根据你的描述整理'}</span>
              </div>
            </div>
            <div className="overview-item">
              <div className="item-icon"><Stethoscope size={18} /></div>
              <div className="item-content">
                <span className="item-label">可能方向</span>
                <span className="item-value">
                  {snapshot?.hypotheses.length
                    ? snapshot.hypotheses
                        .map((h) => `${h.name}（${LIKELIHOOD_LABELS[h.likelihood] ?? h.likelihood}）`)
                        .join('；')
                    : '暂未形成'}
                </span>
              </div>
            </div>
            <div className="overview-item">
              <div className="item-icon"><ClipboardList size={18} /></div>
              <div className="item-content">
                <span className="item-label">待补充信息</span>
                <span className="item-value">
                  {snapshot?.missingInfo.length ? snapshot.missingInfo.join('；') : '暂无'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {snapshot?.searchQueries.length || snapshot?.evidenceSources.length ? (
          <div className="overview-card">
            <div className="overview-header">
              <Search size={20} />
              <h3>联网核查</h3>
            </div>
            {snapshot.searchQueries.length ? (
              <div className="search-query-chips">
                {snapshot.searchQueries.map((query) => (
                  <span className="query-chip" key={query}>{query}</span>
                ))}
              </div>
            ) : null}
            {snapshot.evidenceSources.length ? (
              <div className="source-list compact-source-list">
                {snapshot.evidenceSources.map((source) => (
                  <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                    <span className={`source-level-badge level-${source.credibility.toLowerCase()}`}>
                      {source.credibility} 级
                    </span>
                    {source.title}
                  </a>
                ))}
              </div>
            ) : (
              <p className="search-note">本次未获取到可引用的权威来源，结论未经联网核验。</p>
            )}
          </div>
        ) : null}

        <div className="risk-warning-card">
          <div className="warning-header">
            <ShieldCheck size={20} />
            <h3>风险提醒</h3>
          </div>
          <p>症状可能由多种原因引起，若出现加重、持续或伴随其他症状，建议及时就医。</p>
        </div>
      </aside>
    </section>
  )
}

function ResultView({
  record,
  result,
  copyLabel,
  onCopy,
  onNew,
  onHistory,
}: {
  record: ConsultationRecord | null
  result: Result
  copyLabel: string
  onCopy: (summary: string) => void
  onNew: () => void
  onHistory: () => void
}) {
  const isUrgent = result.urgencyLevel === 'A'
  const missingInformation = result.missingInformation ?? []
  const nextSteps = result.nextSteps?.length ? result.nextSteps : [result.urgencyAdvice]
  const safetyFlags = result.safetyFlags?.length ? result.safetyFlags : result.uncertaintyItems
  const hasAiSummary = result.aiStatus === 'success' && result.aiSummary
  const aiStatusText = aiStatusLabel(result.aiStatus)
  const sourceReferences = result.sourceReferences ?? []

  return (
    <section className="result-layout">
      <div className={`urgency-banner ${isUrgent ? 'urgent' : ''}`}>
        <AlertTriangle size={30} />
        <div>
          <span>紧急程度 {result.urgencyLevel}</span>
          <h1>{result.urgencyTitle}</h1>
          <p>{result.urgencyAdvice}</p>
        </div>
      </div>

      {result.aiStatus && result.aiStatus !== 'success' ? (
        <div className="ai-status-banner">
          <Info size={20} />
          <span>{aiStatusText}</span>
        </div>
      ) : null}

      {hasAiSummary ? (
        <section className="ai-summary-section">
          <div className="section-title-row">
            <Sparkles size={22} />
            <h2>综合整理说明</h2>
          </div>
          <p>{result.aiSummary}</p>
          {result.aiModel ? <span className="model-pill">{result.aiModel}</span> : null}
        </section>
      ) : null}

      <section className={`verification-strip ${result.webSearchUsed ? 'active' : ''}`}>
        <Search size={20} />
        <div>
          <strong>{result.webSearchUsed ? '已请求联网核查' : '未启用联网核查'}</strong>
          <span>{result.webSearchUsed ? '报告结合了权威来源核查结果，但仍不是确诊结论。' : '当前报告基于对话症状整理与联网证据生成，不是确诊结论。'}</span>
        </div>
      </section>

      <div className="result-grid">
        <section className="result-section">
          <h2>可能方向</h2>
          {result.possibleDirections.map((direction) => (
            <article className="direction-card" key={direction.title}>
              <h3>{direction.title}</h3>
              <p>支持点：{direction.support.join('；')}</p>
              <p>仍需注意：{direction.caution.join('；')}</p>
              {direction.suggestedAction ? <p>建议动作：{direction.suggestedAction}</p> : null}
            </article>
          ))}
        </section>

        <aside className="summary-panel">
          <h2>医生沟通摘要</h2>
          <pre>{result.doctorSummary}</pre>
          <button className="primary-button" onClick={() => onCopy(result.doctorSummary)} type="button">
            <Copy size={18} />
            {copyLabel}
          </button>
        </aside>
      </div>

      {sourceReferences.length ? (
        <section className="source-section">
          <h2>核查来源</h2>
          <div className="source-list">
            {sourceReferences.map((source) => (
              <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                {source.sourceLevel ? (
                  <span className={`source-level-badge level-${source.sourceLevel.toLowerCase()}`}>
                    {source.sourceLevel} 级
                  </span>
                ) : null}
                <strong>{source.title}</strong>
                {source.content ? <span>{source.content}</span> : null}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <div className="info-columns">
        <section>
          <h2>建议科室</h2>
          <p>{result.departmentSuggestion}</p>
        </section>
        <section>
          <h2>下一步</h2>
          <ul>{nextSteps.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section>
          <h2>还缺哪些信息</h2>
          {missingInformation.length ? (
            <ul>{missingInformation.map((item) => <li key={item}>{item}</li>)}</ul>
          ) : (
            <p>本次信息已基本覆盖当前整理所需的关键字段。</p>
          )}
        </section>
      </div>

      <div className="info-columns">
        <section>
          <h2>日常注意</h2>
          <ul>{result.dailyAdvice.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section>
          <h2>不确定项</h2>
          <ul>{result.uncertaintyItems.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section className="safety-section">
          <div className="section-title-row compact">
            <ListChecks size={20} />
            <h2>安全边界</h2>
          </div>
          <ul>{safetyFlags.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      </div>

      {record ? (
        <p className="record-footnote">记录已保存：{record.chiefComplaint}</p>
      ) : null}

      <div className="step-actions result-actions">
        <button className="secondary-button" onClick={onHistory} type="button">
          查看历史
        </button>
        <button className="primary-button" onClick={onNew} type="button">
          新建咨询
          <ArrowRight size={18} />
        </button>
      </div>
    </section>
  )
}

/** SSE 流式咨询：边收过程事件边回调，返回 final 事件 */
async function streamAgentConsult(
  body: { caseId?: string; message: string },
  onEvent: (event: AgentStreamEvent) => void,
): Promise<{ response: AgentResponse; record?: ConsultationRecord }> {
  const response = await fetch(`${API_BASE}/agent/consult/stream`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(typeof data.message === 'string' ? data.message : '请求失败')
  }
  if (!response.body) {
    throw new Error('当前浏览器不支持流式响应')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalEvent: { response: AgentResponse; record?: ConsultationRecord } | null = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let separatorIndex = buffer.indexOf('\n\n')
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)
      separatorIndex = buffer.indexOf('\n\n')

      const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '))
      if (!dataLine) continue

      let event: AgentStreamEvent
      try {
        event = JSON.parse(dataLine.slice(6)) as AgentStreamEvent
      } catch {
        continue
      }

      if (event.type === 'final') {
        finalEvent = { response: event.response, record: event.record }
      } else if (event.type === 'error') {
        throw new Error(event.message)
      } else {
        onEvent(event)
      }
    }
  }

  if (!finalEvent) {
    throw new Error('分析服务连接中断，请重试。')
  }
  return finalEvent
}

/** 把流式事件转成"可审计过程"展示行 */
function describeStreamEvent(event: AgentStreamEvent): string | null {
  switch (event.type) {
    case 'status':
      return event.message
    case 'extracted_facts':
      return event.facts.length
        ? `已提取信息：${event.facts.map((f) => `${f.label} ${f.value}`).join('；')}`
        : null
    case 'risk_check': {
      const parts = [`风险核查：${event.level}`]
      if (event.confirmed.length) parts.push(`需警惕 ${event.confirmed.join('、')}`)
      if (event.denied.length) parts.push(`已排除 ${event.denied.join('、')}`)
      if (event.unresolved.length) parts.push(`待确认 ${event.unresolved.join('、')}`)
      return parts.join('；')
    }
    case 'search_query':
      return `检索：${event.queries.join('；')}`
    case 'search_result':
      return `已获取 ${event.sources.length} 条权威来源：${event.sources.slice(0, 3).map((s) => s.title).join('；')}`
    default:
      return null
  }
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof data.message === 'string' ? data.message : '请求失败')
  }

  return data as T
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function aiStatusLabel(status: Result['aiStatus']) {
  if (status === 'fallback') {
    return '本次智能整理暂不可用，已给出基础安全提示与观察建议。'
  }

  if (status === 'disabled') {
    return '智能整理未启用，当前仅展示基础安全提示。'
  }

  if (status === 'error') {
    return '智能整理返回异常，当前仅展示基础安全提示。'
  }

  return ''
}

function agentResponseToChatMessage(response: AgentResponse): ChatMessage {
  if (response.type === 'followup') {
    return {
      role: 'assistant',
      kind: 'followup',
      followupMode: response.mode,
      content: response.intro,
      questions: response.questions,
    }
  }

  if (response.type === 'emergency') {
    return {
      role: 'assistant',
      kind: 'emergency',
      content: `${response.content}\n\n医生沟通摘要（可直接出示给医生）：\n${response.doctorSummary}`,
    }
  }

  if (response.type === 'final_report') {
    return {
      role: 'assistant',
      kind: 'final_report',
      content: response.rendered,
    }
  }

  return {
    role: 'assistant',
    kind: 'stage_report',
    content: response.content,
  }
}

export default App
