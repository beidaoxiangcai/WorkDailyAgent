import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import {
  aggregateUsage,
  buildActivityBlocks,
  formatClock,
  formatDuration,
  formatPercentage,
  getAppPalette,
  hasOverlappingEvents,
  localDayStartTs,
  mixWithWhite,
  splitIntoTimelineRanges,
  todayString,
  type ActivityEvent,
  type TimelineBlock,
  type UsageItem,
} from './activity-analysis'
import './ActivityAnalysisPage.css'

interface TooltipDetail {
  app: string
  title: string | null
  startTs: number
  endTs: number
  x: number
  y: number
}

function tooltipPosition(x: number, y: number): { left: number; top: number } {
  const width = 260
  const height = 88
  const gap = 12
  return {
    left: Math.max(12, Math.min(x + gap, window.innerWidth - width - 12)),
    top: Math.max(12, Math.min(y + gap, window.innerHeight - height - 12)),
  }
}

function ActivityTooltip({ detail }: { detail: TooltipDetail }) {
  const position = tooltipPosition(detail.x, detail.y)
  return createPortal(
    <div
      className="activity-tooltip"
      style={{ left: position.left, top: position.top }}
      role="tooltip"
    >
      <div className="activity-tooltip-title">
        {detail.app}
        {detail.title ? ` — ${detail.title}` : ''}
      </div>
      <div className="activity-tooltip-meta">
        {formatClock(detail.startTs)}–{formatClock(detail.endTs)} ·{' '}
        {formatDuration((detail.endTs - detail.startTs) * 1000)}
      </div>
    </div>,
    document.body,
  )
}

function TimelineAxis({ startHour }: { startHour: number }) {
  const hours = Array.from({ length: 7 }, (_, index) => startHour + index * 2)
  return (
    <div className="activity-axis" aria-hidden="true">
      {hours.map((hour, index) => (
        <div
          className={`activity-axis-tick ${index === 0 ? 'first' : ''} ${index === hours.length - 1 ? 'last' : ''}`}
          key={hour}
          style={{ left: `${(index / (hours.length - 1)) * 100}%` }}
        >
          <span>{String(hour).padStart(2, '0')}:00</span>
        </div>
      ))}
    </div>
  )
}

function TimelineEventBlock({
  block,
  onTooltip,
}: {
  block: TimelineBlock
  onTooltip: (detail: TooltipDetail | null) => void
}) {
  const palette = getAppPalette(block.key, block.app)
  const hasMultipleTitles = block.visibleTitleSegments.length > 1
  const firstTitle = block.visibleTitleSegments[0]?.title ?? null
  const setTooltip = (
    event: React.MouseEvent,
    detail: Omit<TooltipDetail, 'x' | 'y'>,
  ) => {
    onTooltip({ ...detail, x: event.clientX, y: event.clientY })
  }

  return (
    <div
      className={`activity-event-block ${hasMultipleTitles ? 'grouped' : 'single'}`}
      style={{
        left: `${block.leftPercent}%`,
        width: `${block.widthPercent}%`,
        borderColor: palette.main,
        backgroundColor: palette.surface,
      }}
      onMouseMove={(event) =>
        setTooltip(event, {
          app: block.app,
          title: hasMultipleTitles ? null : firstTitle,
          startTs: block.segmentStartTs,
          endTs: block.segmentEndTs,
        })
      }
      onMouseLeave={() => onTooltip(null)}
      aria-label={`${block.app} ${formatClock(block.segmentStartTs)}至${formatClock(block.segmentEndTs)}`}
      data-app={block.app}
      data-start-ts={block.segmentStartTs}
      data-end-ts={block.segmentEndTs}
    >
      <div
        className="activity-event-app"
        style={{ color: palette.text }}
      >
        {block.app}
      </div>
      {hasMultipleTitles && (
        <div className="activity-title-track">
          {block.visibleTitleSegments.map((segment, index) => {
            const whiteRatio = [0.72, 0.18, 0.5, 0.32][index % 4]
            const backgroundColor = mixWithWhite(palette.main, whiteRatio)
            const darkText = whiteRatio >= 0.5
            return (
              <div
                className="activity-title-segment"
                key={`${segment.startTs}-${segment.endTs}-${segment.title ?? ''}`}
                style={{
                  left: `${segment.leftPercent}%`,
                  width: `${segment.widthPercent}%`,
                  backgroundColor,
                  color: darkText ? '#111827' : '#ffffff',
                }}
                onMouseMove={(event) => {
                  event.stopPropagation()
                  setTooltip(event, {
                    app: block.app,
                    title: segment.title,
                    startTs: segment.startTs,
                    endTs: segment.endTs,
                  })
                }}
              >
                <span>{segment.title || '(无标题)'}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TimelineSection({
  events,
  selectedDate,
}: {
  events: ActivityEvent[]
  selectedDate: string
}) {
  const [tooltip, setTooltip] = useState<TooltipDetail | null>(null)
  const ranges = useMemo(() => {
    const blocks = buildActivityBlocks(events)
    return splitIntoTimelineRanges(blocks, localDayStartTs(selectedDate))
  }, [events, selectedDate])

  return (
    <section className="activity-section activity-timeline-section">
      <h3>行动轨迹</h3>
      {ranges.map((range) => (
        <div className="activity-range" key={range.startHour}>
          <div className="activity-range-title">
            {String(range.startHour).padStart(2, '0')}:00 –{' '}
            {String(range.endHour).padStart(2, '0')}:00
          </div>
          <TimelineAxis startHour={range.startHour} />
          <div className="activity-track">
            {range.blocks.map((block) => (
              <TimelineEventBlock
                block={block}
                key={`${block.key}-${block.segmentStartTs}-${block.segmentEndTs}`}
                onTooltip={setTooltip}
              />
            ))}
          </div>
        </div>
      ))}
      {tooltip && <ActivityTooltip detail={tooltip} />}
    </section>
  )
}

function DonutChart({ items }: { items: UsageItem[] }) {
  let offset = 0
  return (
    <svg
      className="usage-donut"
      viewBox="0 0 200 200"
      role="img"
      aria-label="应用使用时长占比"
    >
      <circle className="usage-donut-track" cx="100" cy="100" r="72" />
      {items.map((item) => {
        const startOffset = offset
        const value = item.ratio * 100
        offset += value
        const palette = getAppPalette(item.key, item.app)
        const midpoint = (startOffset + value / 2) * 3.6 - 90
        const radians = (midpoint * Math.PI) / 180
        const labelRadius = 72
        const labelX = 100 + Math.cos(radians) * labelRadius
        const labelY = 100 + Math.sin(radians) * labelRadius
        return (
          <g key={item.key}>
            <circle
              className="usage-donut-segment"
              cx="100"
              cy="100"
              r="72"
              pathLength="100"
              stroke={palette.main}
              strokeDasharray={`${value} ${100 - value}`}
              strokeDashoffset={-startOffset}
            />
            {item.ratio >= 0.06 && (
              <text x={labelX} y={labelY} className="usage-donut-label">
                {formatPercentage(item.ratio)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function UsageSection({ events }: { events: ActivityEvent[] }) {
  const items = useMemo(() => aggregateUsage(events), [events])
  const [expandedApps, setExpandedApps] = useState<Set<string>>(
    () => new Set(),
  )
  const toggleExpanded = (key: string) => {
    setExpandedApps((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section className="activity-section usage-section">
      <h3>应用使用占比</h3>
      {items.length === 0 ? (
        <div className="activity-empty">暂无应用使用数据</div>
      ) : (
        <div className="usage-content">
          <DonutChart items={items} />
          <div className="usage-list">
            {items.map((item) => {
              const palette = getAppPalette(item.key, item.app)
              const expanded = expandedApps.has(item.key)
              const detailId = `usage-details-${item.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
              return (
                <div className="usage-item" key={item.key}>
                  <button
                    type="button"
                    className="usage-row"
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    onClick={() => toggleExpanded(item.key)}
                  >
                    <span
                      className={`usage-expand-icon ${expanded ? 'expanded' : ''}`}
                      aria-hidden="true"
                    />
                    <span
                      className="usage-swatch"
                      style={{ backgroundColor: palette.main }}
                    />
                    <span className="usage-app">{item.app}</span>
                    <span className="usage-duration">
                      {formatDuration(item.durationMs)}
                    </span>
                    <span className="usage-ratio">
                      {formatPercentage(item.ratio)}
                    </span>
                  </button>
                  {expanded && (
                    <div className="usage-details" id={detailId}>
                      {item.details.map((detail, index) => (
                        <div
                          className="usage-detail-row"
                          key={`${detail.id}-${detail.startTs}-${index}`}
                        >
                          <span
                            className="usage-detail-title"
                            title={detail.title || '(无标题)'}
                          >
                            {detail.title || '(无标题)'}
                          </span>
                          <span className="usage-detail-time">
                            {formatClock(detail.startTs)}–
                            {formatClock(detail.endTs)}
                          </span>
                          <span className="usage-detail-duration">
                            {formatDuration(detail.durationMs)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

export default function ActivityAnalysisPage() {
  const [selectedDate, setSelectedDate] = useState(todayString())
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (
        import.meta.env.DEV &&
        new URLSearchParams(window.location.search).has('activityDemo')
      ) {
        const { buildActivityDemoEvents } = await import(
          './activity-analysis-demo'
        )
        setEvents(buildActivityDemoEvents(selectedDate))
        return
      }
      const rows = await invoke<ActivityEvent[]>('query_events', {
        date: selectedDate,
      })
      if (hasOverlappingEvents(rows)) {
        console.warn('[activity-analysis] 查询结果存在重叠事件')
      }
      setEvents(rows)
    } catch (loadError) {
      setError(String(loadError))
    } finally {
      setLoading(false)
    }
  }, [selectedDate])

  useEffect(() => {
    loadEvents()
    if (selectedDate !== todayString()) return
    const timer = setInterval(loadEvents, 10000)
    return () => clearInterval(timer)
  }, [loadEvents, selectedDate])

  return (
    <div className="activity-page">
      <div className="activity-page-header">
        <h2>活动分析</h2>
        <input
          type="date"
          className="date-picker"
          value={selectedDate}
          max={todayString()}
          onChange={(event) => {
            if (event.target.value) setSelectedDate(event.target.value)
          }}
          aria-label="选择活动日期"
        />
      </div>
      {error && <div className="error-msg">加载失败: {error}</div>}
      {!error && loading && events.length === 0 && (
        <div className="activity-empty">正在加载…</div>
      )}
      {!error && !loading && events.length === 0 && (
        <div className="activity-empty">所选日期暂无采集数据</div>
      )}
      {!error && events.length > 0 && (
        <div className="activity-page-content">
          <TimelineSection events={events} selectedDate={selectedDate} />
          <UsageSection events={events} />
        </div>
      )}
    </div>
  )
}
