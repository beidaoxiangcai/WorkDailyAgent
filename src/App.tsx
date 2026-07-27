import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'

// ── Rust 后端返回的结构 ──
interface EventRow {
  id: number
  start_ts: number
  end_ts: number
  app: string
  bundle_id: string
  window_title: string | null
  duration_ms: number
}

interface ReportRow {
  id: number
  type: string
  period_date: string
  generated_at: number
  content: string
  llm_model: string | null
}

// ── 导航项 ──
type Page = 'timeline' | 'reports' | 'settings'
const NAV_ITEMS: { key: Page; label: string }[] = [
  { key: 'timeline', label: '今日时间轴' },
  { key: 'reports', label: '日报/周报' },
  { key: 'settings', label: '设置' },
]

// ── 工具函数 ──
function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000)
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${min}`
}

function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000)
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mo}-${day} ${h}:${min}`
}

function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h${m}min` : `${h}h`
}

function App() {
  const [page, setPage] = useState<Page>('timeline')
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [generating, setGenerating] = useState(false)

  // 查询当日事件
  const loadEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await invoke<EventRow[]>('query_events', { date: todayStr() })
      setEvents(rows)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 读取采集暂停状态
  const loadPaused = useCallback(async () => {
    try {
      setPaused(await invoke<boolean>('is_paused'))
    } catch {
      // 命令未就绪时忽略
    }
  }, [])

  useEffect(() => {
    loadEvents()
    loadPaused()
    const timer = setInterval(loadEvents, 10000)
    return () => clearInterval(timer)
  }, [loadEvents, loadPaused])

  // 切换暂停/恢复
  const togglePause = async () => {
    const next = !paused
    try {
      await invoke('set_paused', { paused: next })
      setPaused(next)
    } catch (e) {
      setError(String(e))
    }
  }

  // 生成今日日报
  const generateReport = async () => {
    setGenerating(true)
    setError(null)
    try {
      await invoke<string>('generate_daily_report')
      // 生成完成后跳转到日报页
      setPage('reports')
    } catch (e) {
      setError(String(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="layout">
      <header className="header">
        <h1>工作日报 Agent</h1>
        <div className="header-right">
          <span className={`status-dot ${paused ? 'paused' : ''}`} />
          <button
            className="generate-btn"
            onClick={generateReport}
            disabled={generating}
          >
            {generating ? '生成中…' : '生成今日日报'}
          </button>
          <button className="pause-btn" onClick={togglePause}>
            {paused ? '恢复采集' : '暂停采集'}
          </button>
        </div>
      </header>

      <nav className="nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            className={`nav-item ${page === item.key ? 'active' : ''}`}
            onClick={() => setPage(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="main">
        {page === 'timeline' && (
          <TimelinePage
            events={events}
            loading={loading}
            error={error}
            onRefresh={loadEvents}
            paused={paused}
          />
        )}
        {page === 'reports' && <ReportsPage />}
        {page === 'settings' && <PlaceholderPage text="设置页（S5 实现）" />}
      </main>
    </div>
  )
}

// ── 今日时间轴页 ──
function TimelinePage({
  events,
  loading,
  error,
  onRefresh,
  paused,
}: {
  events: EventRow[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  paused: boolean
}) {
  return (
    <>
      <div className="timeline-header">
        <h2>今日时间轴 {paused && '· 已暂停'}</h2>
        <button className="refresh-btn" onClick={onRefresh} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      {error && <div className="error-msg">加载失败: {error}</div>}
      {!error && events.length === 0 && (
        <div className="empty-state">暂无采集事件，稍后会自动出现</div>
      )}
      {!error && events.length > 0 && (
        <div className="event-list">
          {events.map((ev) => (
            <div className="event-card" key={ev.id}>
              <div className="event-time">{formatTime(ev.start_ts)}</div>
              <div className="event-body">
                <div className="event-app">{ev.app}</div>
                <div className="event-title">
                  {ev.window_title || '(无标题)'}
                </div>
              </div>
              <div className="event-duration">
                {formatDuration(ev.duration_ms)}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ── 日报/周报页 ──
function ReportsPage() {
  const [tab, setTab] = useState<'daily' | 'weekly'>('daily')
  const [reports, setReports] = useState<ReportRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)

  const loadReports = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await invoke<ReportRow[]>('get_reports', {
        reportType: tab,
      })
      setReports(rows)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    loadReports()
  }, [loadReports])

  const handleCopy = async (report: ReportRow) => {
    try {
      await navigator.clipboard.writeText(report.content)
      setCopiedId(report.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      // 剪贴板失败时用选中文本兜底
    }
  }

  return (
    <>
      <div className="reports-tabs">
        <button
          className={`tab-btn ${tab === 'daily' ? 'active' : ''}`}
          onClick={() => setTab('daily')}
        >
          日报
        </button>
        <button
          className={`tab-btn ${tab === 'weekly' ? 'active' : ''}`}
          onClick={() => setTab('weekly')}
        >
          周报
        </button>
      </div>

      {error && <div className="error-msg">加载失败: {error}</div>}
      {!error && !loading && reports.length === 0 && (
        <div className="empty-state">
          暂无{tab === 'daily' ? '日报' : '周报'}，点击顶栏"生成今日日报"创建
        </div>
      )}
      {!error && reports.length > 0 && (
        <div className="report-list">
          {reports.map((r) => (
            <div className="report-card" key={r.id}>
              <div className="report-card-header">
                <span className="report-meta">
                  {r.period_date} · {formatDateTime(r.generated_at)}
                </span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {r.llm_model && (
                    <span className="report-model">{r.llm_model}</span>
                  )}
                  <button
                    className={`copy-btn ${copiedId === r.id ? 'copied' : ''}`}
                    onClick={() => handleCopy(r)}
                  >
                    {copiedId === r.id ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
              <div className="report-content">{r.content}</div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ── 占位页 ──
function PlaceholderPage({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>
}

export default App
