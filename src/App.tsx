import * as React from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  ClipboardList,
  Clock,
  Copy,
  FileText,
  FolderPlus,
  HeartPulse,
  History,
  Info,
  ListChecks,
  LogOut,
  Paperclip,
  Pill,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Trash2,
  User,
  Users,
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

type QuestionOption = {
  label: string
  value: string
}

type Question = {
  key: string
  text: string
  type: 'single' | 'multi' | 'text'
  required?: boolean
  options?: QuestionOption[]
  placeholder?: string
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

type ChatMessage = {
  role: 'assistant' | 'user'
  content: string
  aiStatus?: Result['aiStatus']
  sourceReferences?: SourceReference[]
  webSearchUsed?: boolean
}

type AiChatReply = {
  aiStatus: Result['aiStatus']
  aiModel?: string
  message: string
  sourceReferences: SourceReference[]
  webSearchUsed: boolean
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

type View = 'home' | 'auth' | 'consult' | 'aiChat' | 'result' | 'history' | 'detail'
type AuthStatus = 'checking' | 'authenticated' | 'anonymous'

const examples = [
  '我爸最近总是头晕，是怎么回事？',
  '胸口闷，需要马上去医院吗？',
  '咳嗽两周不好，要挂什么科？',
]

function useSessionState<T>(key: string, initialValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = React.useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(key)
      return stored ? JSON.parse(stored) : initialValue
    } catch {
      return initialValue
    }
  })

  React.useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(state))
    } catch {
      // ignore
    }
  }, [key, state])

  return [state, setState]
}

function App() {
  const [view, setView] = useSessionState<View>('carecue_view', 'home')
  const [user, setUser] = React.useState<User | null>(null)
  const [authStatus, setAuthStatus] = React.useState<AuthStatus>('checking')
  const [authMode, setAuthMode] = React.useState<'login' | 'register'>('login')
  const [account, setAccount] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [chiefComplaint, setChiefComplaint] = useSessionState('carecue_chiefComplaint', '')
  const [scenario, setScenario] = useSessionState('carecue_scenario', '')
  const [scenarioName, setScenarioName] = useSessionState('carecue_scenarioName', '')
  const [questions, setQuestions] = useSessionState<Question[]>('carecue_questions', [])
  const [currentQuestionIndex, setCurrentQuestionIndex] = useSessionState('carecue_currentQuestionIndex', 0)
  const [answers, setAnswers] = useSessionState<Answer[]>('carecue_answers', [])
  const [selectedValues, setSelectedValues] = useSessionState<string[]>('carecue_selectedValues', [])
  const [textAnswer, setTextAnswer] = useSessionState('carecue_textAnswer', '')
  const [extraText, setExtraText] = useSessionState('carecue_extraText', '')
  const [result, setResult] = useSessionState<Result | null>('carecue_result', null)
  const [activeRecord, setActiveRecord] = useSessionState<ConsultationRecord | null>('carecue_activeRecord', null)
  const [records, setRecords] = React.useState<ConsultationRecord[]>([])
  const [chatMessages, setChatMessages] = useSessionState<ChatMessage[]>('carecue_chatMessages', [])
  const [chatInput, setChatInput] = useSessionState('carecue_chatInput', '')
  const [message, setMessage] = React.useState('')
  const [copyLabel, setCopyLabel] = React.useState('复制摘要')
  const [isChatting, setIsChatting] = React.useState(false)
  const [isCompleting, setIsCompleting] = React.useState(false)

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

  const startConsultation = async () => {
    if (chiefComplaint.trim().length < 2) {
      setMessage('请先用一句话描述哪里不舒服。')
      return
    }

    setMessage('')
    try {
      const data = await api<{ scenario: string; scenarioName: string; questions: Question[] }>('/consultations/start', {
        method: 'POST',
        body: { chiefComplaint },
      })
      setScenario(data.scenario)
      setScenarioName(data.scenarioName)
      setQuestions(data.questions)
      setAnswers([])
      setCurrentQuestionIndex(0)
      clearQuestionInput()
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const submitAnswer = async () => {
    const question = questions[currentQuestionIndex]
    if (!question) return

    const answer = buildAnswer(question)
    if (question.required && !answer.answerText) {
      setMessage('这个问题用于风险判断，请选择或填写一个答案。')
      return
    }

    const nextAnswers = [...answers, answer]
    setAnswers(nextAnswers)
    setMessage('')
    clearQuestionInput()

    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((index) => index + 1)
      return
    }

    setChatMessages([{
      role: 'assistant',
      content: '我已经收到你的基础信息。接下来可以继续补充症状变化、诱因、既往病史或用药情况；如果信息已经完整，可以直接生成分析报告。',
    }])
    setView('aiChat')
  }

  const sendChatMessage = async () => {
    const content = chatInput.trim()
    if (!content || isChatting) return

    const nextMessages: ChatMessage[] = [...chatMessages, { role: 'user', content }]
    setChatMessages(nextMessages)
    setChatInput('')
    setMessage('')

    try {
      setIsChatting(true)
      const data = await api<{ reply: AiChatReply }>('/consultations/chat', {
        method: 'POST',
        body: {
          chiefComplaint,
          scenario,
          answers,
          chatMessages: nextMessages.map(toApiChatMessage),
        },
      })
      setChatMessages((items) => [...items, {
        role: 'assistant',
        content: data.reply.message,
        aiStatus: data.reply.aiStatus,
        sourceReferences: data.reply.sourceReferences,
        webSearchUsed: data.reply.webSearchUsed,
      }])
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setIsChatting(false)
    }
  }

  const completeConsultation = async () => {
    try {
      setIsCompleting(true)
      setMessage('')
      const data = await api<{ record: ConsultationRecord; result: Result }>('/consultations/complete', {
        method: 'POST',
        body: {
          chiefComplaint,
          scenario,
          answers,
          chatMessages: chatMessages.map(toApiChatMessage),
        },
      })
      setActiveRecord({ ...data.record, result: data.result })
      setResult(data.result)
      setView('result')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setIsCompleting(false)
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
    setScenario('')
    setScenarioName('')
    setQuestions([])
    setCurrentQuestionIndex(0)
    setAnswers([])
    setChatMessages([])
    setChatInput('')
    setResult(null)
    setActiveRecord(null)
    clearQuestionInput()
  }

  const clearQuestionInput = () => {
    setSelectedValues([])
    setTextAnswer('')
    setExtraText('')
  }

  const currentQuestion = questions[currentQuestionIndex]

  return (
    <main className="app-shell">
      {view !== 'aiChat' && (
        <header className="topbar">
          <button className="brand-button" onClick={() => setView('home')} type="button">
            <span className="brand-mark">
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
            <p>阶段 2 从真实登录开始，咨询记录只归属当前用户。密码会哈希存储，核心业务数据写入 PostgreSQL。</p>
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
          <div className="workspace-header">
            <span className="eyebrow">阶段 2 原型</span>
            <h1>先说哪里不舒服，再一步步补齐关键信息</h1>
            <p>规则原型覆盖头晕、胸痛、咳嗽三类场景。未补齐关键字段前，不输出确定性疾病判断。</p>
          </div>

          {!questions.length ? (
            <div className="consult-grid">
              <div className="input-panel">
                <label>
                  这次想咨询什么不舒服？
                  <textarea
                    value={chiefComplaint}
                    onChange={(event) => setChiefComplaint(event.target.value)}
                    placeholder="例如：我爸最近总是头晕，站起来更明显"
                    rows={7}
                  />
                </label>
                <div className="example-row">
                  {examples.map((example) => (
                    <button key={example} onClick={() => setChiefComplaint(example)} type="button">
                      {example}
                    </button>
                  ))}
                </div>
                <button className="primary-button" onClick={startConsultation} type="button">
                  开始追问
                  <ArrowRight size={18} />
                </button>
              </div>
              <aside className="urgent-panel">
                <AlertTriangle size={24} />
                <h2>紧急情况优先线下处理</h2>
                <p>胸痛伴呼吸困难、突发一侧肢体无力、说话不清、意识模糊、大量出血等情况，不建议等待线上整理结果。</p>
              </aside>
            </div>
          ) : (
            <div className="question-layout">
              <aside className="progress-panel">
                <span>{scenarioName}</span>
                <h2>{currentQuestionIndex + 1} / {questions.length}</h2>
                <p>{chiefComplaint}</p>
              </aside>
              <section className="question-panel">
                <h2>{currentQuestion?.text}</h2>
                {currentQuestion ? (
                  <QuestionInput
                    question={currentQuestion}
                    selectedValues={selectedValues}
                    setSelectedValues={setSelectedValues}
                    textAnswer={textAnswer}
                    setTextAnswer={setTextAnswer}
                    extraText={extraText}
                    setExtraText={setExtraText}
                  />
                ) : null}
                <div className="step-actions">
                  <button className="secondary-button" onClick={resetConsultation} type="button">
                    重新输入
                  </button>
                  <button className="primary-button" disabled={isCompleting} onClick={submitAnswer} type="button">
                    {currentQuestionIndex < questions.length - 1 ? '下一步' : isCompleting ? '正在生成' : '生成结果'}
                    <ArrowRight size={18} />
                  </button>
                </div>
              </section>
            </div>
          )}
        </section>
      ) : null}

      {view === 'result' && result ? (
        <ResultView
          record={activeRecord}
          result={result}
          copyLabel={copyLabel}
          onCopy={copySummary}
          onNew={() => {
            resetConsultation()
            setView('consult')
          }}
          onHistory={loadHistory}
        />
      ) : null}

      {view === 'aiChat' ? (
        <ChatView
          answers={answers}
          chatInput={chatInput}
          chatMessages={chatMessages}
          chiefComplaint={chiefComplaint}
          isChatting={isChatting}
          isCompleting={isCompleting}
          onBack={() => setView('consult')}
          onComplete={completeConsultation}
          onInputChange={setChatInput}
          onSend={sendChatMessage}
          scenarioName={scenarioName}
        />
      ) : null}

      {view === 'history' ? (
        <section className="workspace">
          <div className="workspace-header compact-header">
            <span className="eyebrow">历史记录</span>
            <h1>只展示当前登录用户的咨询记录</h1>
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
              <div className="empty-state">暂无历史咨询。完成一次咨询后，这里会从数据库读取记录。</div>
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

  function buildAnswer(question: Question): Answer {
    if (question.type === 'text') {
      return {
        questionKey: question.key,
        questionText: question.text,
        answerValue: textAnswer.trim(),
        answerText: textAnswer.trim(),
      }
    }

    const optionLabels = question.options
      ?.filter((option) => selectedValues.includes(option.value))
      .map((option) => option.label) ?? []
    const combinedText = [...optionLabels, extraText.trim()].filter(Boolean).join('；')

    return {
      questionKey: question.key,
      questionText: question.text,
      answerValue: question.type === 'single' ? selectedValues[0] ?? '' : selectedValues,
      answerText: combinedText,
    }
  }
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
          <p>通过追问、风险分级和医生沟通摘要，帮助长辈和家人把零散描述整理成可就医、可转发、可保存的信息。</p>
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
          <h2>先追问</h2>
          <p>按就医逻辑补齐年龄、时间、程度、伴随症状、病史和用药。</p>
        </article>
        <article>
          <ShieldCheck size={26} />
          <h2>再分级</h2>
          <p>红旗症状规则前置，高风险场景优先提示急诊。</p>
        </article>
        <article>
          <FileText size={26} />
          <h2>再整理</h2>
          <p>生成客观病情摘要，方便发给家人或带去医院。</p>
        </article>
      </section>

      <section className="boundary-section" id="boundary">
        <div>
          <span className="eyebrow">Safety boundary</span>
          <h2>医疗健康场景里，克制比聪明更重要</h2>
        </div>
        <ul>
          <li>不输出“确诊为”“一定是”等确定性诊断措辞。</li>
          <li>胸痛、肢体无力、说话不清、呼吸困难等红旗信号优先升级。</li>
          <li>结果保留依据、不确定项和线下就医建议。</li>
        </ul>
      </section>
    </>
  )
}

function QuestionInput({
  question,
  selectedValues,
  setSelectedValues,
  textAnswer,
  setTextAnswer,
  extraText,
  setExtraText,
}: {
  question: Question
  selectedValues: string[]
  setSelectedValues: React.Dispatch<React.SetStateAction<string[]>>
  textAnswer: string
  setTextAnswer: React.Dispatch<React.SetStateAction<string>>
  extraText: string
  setExtraText: React.Dispatch<React.SetStateAction<string>>
}) {
  if (question.type === 'text') {
    return (
      <textarea
        value={textAnswer}
        onChange={(event) => setTextAnswer(event.target.value)}
        placeholder={question.placeholder ?? '请简单说明'}
        rows={5}
      />
    )
  }

  const toggle = (value: string) => {
    if (question.type === 'single') {
      setSelectedValues([value])
      return
    }

    setSelectedValues((values) => (
      values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
    ))
  }

  return (
    <>
      <div className="option-grid">
        {question.options?.map((option) => (
          <button
            className={selectedValues.includes(option.value) ? 'selected' : ''}
            key={option.value}
            onClick={() => toggle(option.value)}
            type="button"
          >
            <CheckCircle2 size={18} />
            {option.label}
          </button>
        ))}
      </div>
      <label className="extra-field">
        其他/补充说明
        <textarea
          value={extraText}
          onChange={(event) => setExtraText(event.target.value)}
          placeholder="如果选项不准确，可以在这里补充"
          rows={3}
        />
      </label>
    </>
  )
}

function ChatView({
  answers,
  chatInput,
  chatMessages,
  chiefComplaint,
  isChatting,
  isCompleting,
  onBack,
  onComplete,
  onInputChange,
  onSend,
  scenarioName,
}: {
  answers: Answer[]
  chatInput: string
  chatMessages: ChatMessage[]
  chiefComplaint: string
  isChatting: boolean
  isCompleting: boolean
  onBack: () => void
  onComplete: () => void
  onInputChange: (value: string) => void
  onSend: () => void
  scenarioName: string
}) {
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onSend()
  }

  const getAnswer = (keys: string[]) => {
    const found = answers.find((a) => keys.includes(a.questionKey))
    return found?.answerText || '未说明'
  }

  const patient = getAnswer(['patient'])
  const age = getAnswer(['age'])
  const duration = getAnswer(['duration'])
  const accompanying = getAnswer(['dizziness_red_flags', 'chest_red_flags', 'cough_red_flags', 'sputum'])
  const history = getAnswer(['history'])
  const medication = getAnswer(['medication'])

  return (
    <section className="chat-layout-redesigned">
      <div className="chat-main-col">
        <div className="chat-panel-header-redesigned">
          <button className="ghost-button" onClick={onBack} type="button">
            <ArrowLeft size={18} />
            返回
          </button>
          <h2>{scenarioName || '症状咨询'}</h2>
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

          <div className="chat-card details-card">
            <div className="card-header">
              <FileText size={20} />
              <h3>补充信息</h3>
            </div>
            <div className="details-table">
              {answers.map((answer) => (
                <div className="details-row" key={answer.questionKey}>
                  <span className="question-col">• {answer.questionText}</span>
                  <span className="answer-col">{answer.answerText || '未说明'}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="chat-card ai-welcome-card">
            <div className="card-icon ai-icon"><Bot size={28} /></div>
            <div className="card-content">
              <h3>问康 AI</h3>
              <p>我已经接收到你的基础信息，接下来可以继续补充症状变化、诱因、既往病史或用药情况；如果信息已经完整，可以直接生成分析报告。</p>
            </div>
            <div className="card-decoration"><ShieldCheck size={80} /></div>
          </div>

          {chatMessages.slice(1).map((item, index) => (
            <div className={`chat-card message-card ${item.role}`} key={index}>
              <div className={`card-icon ${item.role === 'assistant' ? 'ai-icon' : ''}`}>
                {item.role === 'assistant' ? <Bot size={28} /> : <User size={28} />}
              </div>
              <div className="card-content">
                <h3>{item.role === 'assistant' ? '问康 AI' : '补充诉求'}</h3>
                <p>{item.content}</p>
                {item.sourceReferences?.length ? (
                  <div className="source-list compact-source-list">
                    {item.sourceReferences.map((source) => (
                      <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                        {source.title}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {isChatting ? (
            <div className="chat-card message-card assistant">
               <div className="card-icon ai-icon"><Bot size={28} /></div>
               <div className="card-content">
                 <h3>问康 AI</h3>
                 <p>正在整理并核查你补充的信息...</p>
               </div>
            </div>
          ) : null}
        </div>

        <form className="chat-input-row-redesigned" onSubmit={handleSubmit}>
          <div className="attachment-icon"><Paperclip size={20} /></div>
          <textarea
            value={chatInput}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="补充症状、持续时间、诱因、既往病史、当前用药等"
            rows={1}
          />
          <button className="primary-button send-btn" disabled={!chatInput.trim() || isChatting} type="submit" aria-label="发送">
            <Send size={18} />
          </button>
        </form>

        <div className="chat-actions-redesigned">
          <button className="primary-button large-cta" disabled={isCompleting} onClick={onComplete} type="button">
            <Sparkles size={20} />
            {isCompleting ? '正在生成报告...' : '生成分析报告'}
          </button>
          <p>
            <Info size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
            AI 聊天用于补充和核查信息，不是正式确诊。
          </p>
        </div>
      </div>

      <aside className="chat-sidebar-col">
        <div className="overview-card">
          <div className="overview-header">
            <User size={20} />
            <h3>患者概览</h3>
          </div>
          <div className="overview-list">
            <div className="overview-item">
              <div className="item-icon"><User size={18} /></div>
              <div className="item-content">
                <span className="item-label">就诊对象</span>
                <span className="item-value">{patient}</span>
              </div>
            </div>
            <div className="overview-item">
              <div className="item-icon"><ClipboardList size={18} /></div>
              <div className="item-content">
                <span className="item-label">年龄</span>
                <span className="item-value">{age}</span>
              </div>
            </div>
            <div className="overview-item">
              <div className="item-icon"><Clock size={18} /></div>
              <div className="item-content">
                <span className="item-label">持续时间</span>
                <span className="item-value">{duration}</span>
              </div>
            </div>
            <div className="overview-item">
              <div className="item-icon"><Users size={18} /></div>
              <div className="item-content">
                <span className="item-label">伴随症状</span>
                <span className="item-value">{accompanying}</span>
              </div>
            </div>
            <div className="overview-item">
              <div className="item-icon"><FolderPlus size={18} /></div>
              <div className="item-content">
                <span className="item-label">既往病史</span>
                <span className="item-value">{history}</span>
              </div>
            </div>
            <div className="overview-item">
              <div className="item-icon"><Pill size={18} /></div>
              <div className="item-content">
                <span className="item-label">当前用药</span>
                <span className="item-value">{medication}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="risk-warning-card">
          <div className="warning-header">
            <ShieldCheck size={20} />
            <h3>风险提醒</h3>
          </div>
          <p>{scenarioName || '症状'}可能由多种原因引起，若出现加重、持续或伴随其他症状，建议及时就医。</p>
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
            <h2>AI 综合分析</h2>
          </div>
          <p>{result.aiSummary}</p>
          {result.aiModel ? <span className="model-pill">{result.aiModel}</span> : null}
        </section>
      ) : null}

      <section className={`verification-strip ${result.webSearchUsed ? 'active' : ''}`}>
        <Search size={20} />
        <div>
          <strong>{result.webSearchUsed ? '已请求联网核查' : '未启用联网核查'}</strong>
          <span>{result.webSearchUsed ? '报告结合了服务端搜索工具返回的背景资料，但仍不是确诊结论。' : '当前报告基于问卷、聊天补充和规则/AI 分析生成。'}</span>
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
            <p>本次信息已基本覆盖当前分析所需的关键字段。</p>
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
    return '本次 AI 分析暂不可用，已展示规则分析结果。'
  }

  if (status === 'disabled') {
    return 'AI 分析未启用，当前展示规则分析结果。'
  }

  if (status === 'error') {
    return 'AI 分析返回异常，当前展示规则分析结果。'
  }

  return ''
}

function toApiChatMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: message.content,
  }
}

export default App
