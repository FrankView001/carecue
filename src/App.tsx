import {
  ArrowRight,
  BadgeCheck,
  Brain,
  ClipboardList,
  FileText,
  HeartPulse,
  History,
  ShieldAlert,
  Sparkles,
  Stethoscope,
  UserRoundCheck,
} from 'lucide-react'
import heroImage from './assets/carecue-hero.png'
import './App.css'

const processSteps = [
  {
    icon: ClipboardList,
    title: '先把症状问清楚',
    text: '用口语化追问补齐时间、部位、程度、伴随症状、用药和既往病史。',
  },
  {
    icon: Brain,
    title: '再做多证据判断',
    text: '结合权威来源检索、红旗症状规则和模型自检，减少模糊回答。',
  },
  {
    icon: FileText,
    title: '最后生成就医摘要',
    text: '把用户描述整理成医生能快速阅读的病情摘要和建议就诊科室。',
  },
]

const trustItems = [
  '不输出确诊结论，只给就医前判断和风险提示',
  '急症风险优先展示，胸痛、呼吸困难、意识异常等直接提醒就医',
  '回答保留依据、疑点和不确定项，避免把猜测包装成事实',
]

function App() {
  return (
    <main className="site-shell">
      <header className="topbar" aria-label="主导航">
        <a className="brand" href="#top" aria-label="问康首页">
          <span className="brand-mark">
            <HeartPulse size={22} strokeWidth={2.4} />
          </span>
          <span>
            <strong>问康</strong>
            <small>CareCue</small>
          </span>
        </a>
        <nav className="nav-links" aria-label="页面章节">
          <a href="#method">工作方式</a>
          <a href="#trust">可信机制</a>
          <a href="#roadmap">技术方向</a>
        </nav>
        <a className="nav-cta" href="#experience">
          立即体验
          <ArrowRight size={18} />
        </a>
      </header>

      <section className="hero-section" id="top">
        <img
          className="hero-image"
          src={heroImage}
          alt="子女陪伴长辈在家中用平板整理就医前症状信息"
        />
        <div className="hero-overlay" aria-hidden="true" />
        <div className="hero-copy">
          <div className="eyebrow">
            <BadgeCheck size={18} />
            就医前症状整理与日常健康咨询
          </div>
          <h1>
            <span>就医前，</span>
            <span>先把症状</span>
            <span>说清楚。</span>
          </h1>
          <p>
            问康面向长辈、子女和不熟悉搜索的用户，通过一步一步追问、联网查证和风险分级，
            帮你在就医前理清症状、判断紧急程度、准备沟通材料。
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#experience">
              立即体验
              <ArrowRight size={20} />
            </a>
            <a className="secondary-button" href="#trust">
              先看安全边界
            </a>
          </div>
          <div className="hero-note" role="note">
            <ShieldAlert size={18} />
            问康不是确诊工具；出现高危症状时，应立即联系急救或线下就医。
          </div>
        </div>
      </section>

      <section className="problem-band" aria-label="产品要解决的问题">
        <div>
          <span>常见困境</span>
          <h2>不是用户不重视健康，而是很多时候不知道该怎么描述。</h2>
        </div>
        <p>
          疼了多久、哪里疼、是否伴随发热或呼吸困难、吃过什么药，这些信息会直接影响医生判断。
          问康的价值，是把一次紧张、零散的求助，变成可追踪、可转发、可带去医院的结构化材料。
        </p>
      </section>

      <section className="section" id="method">
        <div className="section-heading">
          <span>How it works</span>
          <h2>先追问，再判断，再整理。</h2>
        </div>
        <div className="step-grid">
          {processSteps.map((item) => (
            <article className="step-card" key={item.title}>
              <div className="icon-box">
                <item.icon size={26} />
              </div>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="trust-section" id="trust">
        <div className="trust-copy">
          <span>Trust model</span>
          <h2>医疗场景里，克制比聪明更重要。</h2>
          <p>
            问康不会把一次 AI 回复当作最终答案。产品会用规则、检索、引用、低置信度提示和后续多模型交叉验证，
            让用户知道哪些是建议，哪些仍需医生判断。
          </p>
        </div>
        <div className="trust-panel">
          {trustItems.map((item) => (
            <div className="trust-row" key={item}>
              <UserRoundCheck size={22} />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section compact" id="experience">
        <div className="experience-panel">
          <div>
            <span>Preview</span>
            <h2>下一步进入咨询流程。</h2>
            <p>
              首页确认后，将继续开发登录、问诊追问、结果页、健康档案和医生摘要。这里的按钮会接入真实体验入口。
            </p>
          </div>
          <a className="primary-button" href="#roadmap">
            查看技术方向
            <ArrowRight size={20} />
          </a>
        </div>
      </section>

      <section className="section roadmap" id="roadmap">
        <div className="section-heading">
          <span>Architecture</span>
          <h2>技术方向按上线服务器设计。</h2>
        </div>
        <div className="roadmap-grid">
          <div>
            <Stethoscope size={24} />
            <h3>当前阶段</h3>
            <p>React + Vite + TypeScript，快速搭建可验收 Demo，前端组件按未来业务模块拆分。</p>
          </div>
          <div>
            <Sparkles size={24} />
            <h3>服务端阶段</h3>
            <p>升级为 Next.js 或 React 前端 + Node API，接入登录、数据库、AI 网关和检索服务。</p>
          </div>
          <div>
            <History size={24} />
            <h3>长期能力</h3>
            <p>用户健康画像、历史记忆、周/月建议、多模型交叉验证和权威医学来源白名单。</p>
          </div>
        </div>
      </section>
    </main>
  )
}

export default App
