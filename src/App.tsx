import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './App.css'

// ── Rust 后端返回的事件结构 ──
interface EventRow {
  id: number
  start_ts: number
  end_ts: number
  app: string
  bundle_id: string
  window_title: string | null
  duration_ms: number
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
  // 后端存的是 Unix 秒（UTC），按本地时间显示
  const d = new Date(ts * 1000)
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${min}`
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
    // 每 10 秒自动刷新（与后端 flush 周期一致）
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

  return (
    <div className="layout">
      {/* 顶部标题栏 */}
      <header className="header">
        <h1>工作日报 Agent</h1>
        <div className="header-right">
          <span className={`status-dot ${paused ? 'paused' : ''}`} />
          <button className="pause-btn" onClick={togglePause}>
            {paused ? '恢复采集' : '暂停采集'}
          </button>
        </div>
      </header>

      {/* 左侧导航 */}
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

      {/* 主内容区 */}
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
        {page === 'reports' && <PlaceholderPage text="日报/周报页（S4 实现）" />}
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

// ── 占位页（日报/周报、设置） ──
function PlaceholderPage({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>
}

export default App
