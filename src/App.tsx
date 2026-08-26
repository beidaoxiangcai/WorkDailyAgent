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
  ongoing: boolean
}

interface ReportRow {
  id: number
  type: string
  period_date: string
  generated_at: number
  content: string
  llm_model: string | null
}

interface BlacklistRow {
  id: number
  bundle_id: string
  app_name: string
  created_at: number
}

interface ActiveAppInfo {
  app_name: string
  window_title: string | null
}

// ── 导航项 ──
type Page = 'timeline' | 'reports' | 'settings'
const NAV_ITEMS: { key: Page; label: string }[] = [
  { key: 'timeline', label: '时间轴' },
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
  const [activeApp, setActiveApp] = useState<ActiveAppInfo | null>(null)
  const [timelineDate, setTimelineDate] = useState(todayStr())
  const [reportTrigger, setReportTrigger] = useState(0)

  const loadEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await invoke<EventRow[]>('query_events', { date: timelineDate })
      setEvents(rows)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [timelineDate])

  const loadPaused = useCallback(async () => {
    try {
      setPaused(await invoke<boolean>('is_paused'))
    } catch {
      // 命令未就绪时忽略
    }
  }, [])

  // 轮询当前活跃应用（供"正在记录"展示）
  const loadActiveApp = useCallback(async () => {
    try {
      setActiveApp(await invoke<ActiveAppInfo | null>('get_active_app_info'))
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    loadEvents()
    loadPaused()
    loadActiveApp()
    const eventTimer = setInterval(loadEvents, 10000)
    const activeTimer = setInterval(loadActiveApp, 3000)
    return () => {
      clearInterval(eventTimer)
      clearInterval(activeTimer)
    }
  }, [loadEvents, loadPaused, loadActiveApp])

  const togglePause = async () => {
    const next = !paused
    try {
      await invoke('set_paused', { paused: next })
      setPaused(next)
    } catch (e) {
      setError(String(e))
    }
  }

  const generateReport = async (date?: string) => {
    setGenerating(true)
    setError(null)
    try {
      await invoke<string>('generate_daily_report', { date: date ?? null })
      setReportTrigger((t) => t + 1)
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
            onClick={() => generateReport()}
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
            activeApp={activeApp}
            selectedDate={timelineDate}
            onDateChange={setTimelineDate}
            onGenerateReport={() => generateReport(timelineDate)}
            generating={generating}
          />
        )}
        {page === 'reports' && <ReportsPage refreshTrigger={reportTrigger} />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}

// ── 时间轴页 ──
function TimelinePage({
  events,
  loading,
  error,
  onRefresh,
  paused,
  activeApp,
  selectedDate,
  onDateChange,
  onGenerateReport,
  generating,
}: {
  events: EventRow[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  paused: boolean
  activeApp: ActiveAppInfo | null
  selectedDate: string
  onDateChange: (date: string) => void
  onGenerateReport: () => void
  generating: boolean
}) {
  return (
    <>
      {/* 正在记录提示 */}
      {!paused && activeApp && (
        <div className="recording-banner">
          <span className="status-dot" />
          正在记录：{activeApp.app_name}
          {activeApp.window_title && ` - ${activeApp.window_title}`}
        </div>
      )}
      {paused && (
        <div className="recording-banner idle">采集已暂停，时间轴不再更新</div>
      )}

      <div className="timeline-header">
        <div className="timeline-title-row">
          <h2>时间轴</h2>
          <input
            type="date"
            className="date-picker"
            value={selectedDate}
            max={todayStr()}
            onChange={(e) => onDateChange(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="generate-btn-sm"
            onClick={onGenerateReport}
            disabled={generating || events.length === 0}
          >
            {generating ? '生成中…' : '生成日报'}
          </button>
          <button className="refresh-btn" onClick={onRefresh} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
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
function ReportsPage({ refreshTrigger }: { refreshTrigger: number }) {
  const [tab, setTab] = useState<'daily' | 'weekly'>('daily')
  const [reports, setReports] = useState<ReportRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [selectedDate, setSelectedDate] = useState<string>('')

  const loadReports = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await invoke<ReportRow[]>('get_reports', {
        reportType: tab,
        date: selectedDate || null,
      })
      setReports(rows)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [tab, selectedDate])

  useEffect(() => {
    loadReports()
  }, [loadReports, refreshTrigger])

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
      <div className="reports-toolbar">
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
        <input
          type="date"
          className="date-picker"
          value={selectedDate}
          max={todayStr()}
          onChange={(e) => setSelectedDate(e.target.value)}
        />
        {selectedDate && (
          <button
            className="refresh-btn"
            onClick={() => setSelectedDate('')}
          >
            全部
          </button>
        )}
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
            <ReportCard
              key={r.id}
              report={r}
              copied={copiedId === r.id}
              onCopy={() => handleCopy(r)}
            />
          ))}
        </div>
      )}
    </>
  )
}

// ── 日报卡片（超过5行折叠） ──
function ReportCard({
  report,
  copied,
  onCopy,
}: {
  report: ReportRow
  copied: boolean
  onCopy: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="report-card">
      <div className="report-card-header">
        <span className="report-meta">
          {report.period_date} · {formatDateTime(report.generated_at)}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {report.llm_model && (
            <span className="report-model">{report.llm_model}</span>
          )}
          <button
            className={`copy-btn ${copied ? 'copied' : ''}`}
            onClick={onCopy}
          >
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      <div className={`report-content ${expanded ? '' : 'collapsed'}`}>
        {report.content}
      </div>
      <button
        className="expand-btn"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '收起' : '展开全部'}
      </button>
    </div>
  )
}

// ── 设置页 ──
function SettingsPage() {
  const [blacklist, setBlacklist] = useState<BlacklistRow[]>([])
  const [newBundleId, setNewBundleId] = useState('')
  const [newAppName, setNewAppName] = useState('')
  const [accessGranted, setAccessGranted] = useState(false)
  const [clearing, setClearing] = useState(false)

  const loadBlacklist = useCallback(async () => {
    try {
      setBlacklist(await invoke<BlacklistRow[]>('get_blacklist'))
    } catch {
      // ignore
    }
  }, [])

  const loadAccessStatus = useCallback(async () => {
    try {
      setAccessGranted(await invoke<boolean>('check_accessibility'))
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    loadBlacklist()
    loadAccessStatus()
  }, [loadBlacklist, loadAccessStatus])

  const handleAdd = async () => {
    if (!newBundleId.trim()) return
    try {
      await invoke('add_blacklist', {
        bundleId: newBundleId.trim(),
        appName: newAppName.trim() || newBundleId.trim(),
      })
      setNewBundleId('')
      setNewAppName('')
      await loadBlacklist()
    } catch (e) {
      alert(`添加失败: ${e}`)
    }
  }

  const handleRemove = async (bundleId: string) => {
    try {
      await invoke('remove_blacklist', { bundleId })
      await loadBlacklist()
    } catch (e) {
      alert(`删除失败: ${e}`)
    }
  }

  const handleOpenSettings = async () => {
    try {
      await invoke('open_accessibility_settings')
    } catch (e) {
      alert(`打开失败: ${e}`)
    }
  }

  const handleClearData = async () => {
    if (!confirm('确定要清空所有采集事件和日报吗？此操作不可恢复。')) return
    setClearing(true)
    try {
      await invoke('clear_all_data')
      alert('数据已清空')
    } catch (e) {
      alert(`清空失败: ${e}`)
    } finally {
      setClearing(false)
    }
  }

  return (
    <>
      {/* Accessibility 权限引导 */}
      <div className="settings-section">
        <h2>辅助功能权限</h2>
        <div className="permission-card">
          <div className="permission-info">
            <p>窗口标题采集</p>
            <p className="hint">
              授权后可读取其他应用的窗口标题，仅读标题不读内容
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              className={`permission-status ${accessGranted ? 'granted' : 'denied'}`}
            >
              {accessGranted ? '已授权' : '未授权'}
            </span>
            {!accessGranted && (
              <button className="add-btn" onClick={handleOpenSettings}>
                去授权
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 黑名单管理 */}
      <div className="settings-section">
        <h2>黑名单管理</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          黑名单中的应用不会被采集（如密码管理器、银行 App）
        </p>
        <div className="blacklist-list">
          {blacklist.length === 0 && (
            <div className="empty-state" style={{ padding: 24 }}>
              暂无黑名单项
            </div>
          )}
          {blacklist.map((item) => (
            <div className="blacklist-item" key={item.id}>
              <div>
                <div className="app-name">{item.app_name}</div>
                <div className="bundle-id">{item.bundle_id}</div>
              </div>
              <button
                className="delete-btn"
                onClick={() => handleRemove(item.bundle_id)}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <div className="add-blacklist-row">
          <input
            placeholder="Bundle ID（如 com.apple.Safari）"
            value={newBundleId}
            onChange={(e) => setNewBundleId(e.target.value)}
          />
          <input
            placeholder="应用名（可选）"
            value={newAppName}
            onChange={(e) => setNewAppName(e.target.value)}
            style={{ maxWidth: 120 }}
          />
          <button className="add-btn" onClick={handleAdd}>
            添加
          </button>
        </div>
      </div>

      {/* 数据清空 */}
      <div className="settings-section">
        <h2>数据管理</h2>
        <div className="danger-zone">
          <h3>清空所有数据</h3>
          <p>删除所有采集事件和已生成的日报/周报，黑名单保留。操作不可恢复。</p>
          <button className="clear-btn" onClick={handleClearData} disabled={clearing}>
            {clearing ? '清空中…' : '清空数据'}
          </button>
        </div>
      </div>
    </>
  )
}

export default App
