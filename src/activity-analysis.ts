export const HALF_DAY_SECONDS = 12 * 60 * 60
export const MIN_ACTIVITY_DURATION_SECONDS = 30

export interface ActivityEvent {
  id: number
  start_ts: number
  end_ts: number
  app: string
  bundle_id: string
  window_title: string | null
  duration_ms: number
  ongoing: boolean
}

export interface TitleSegment {
  startTs: number
  endTs: number
  title: string | null
}

export interface ActivityBlock {
  key: string
  app: string
  startTs: number
  endTs: number
  titleSegments: TitleSegment[]
}

export interface TimelineTitleSegment extends TitleSegment {
  leftPercent: number
  widthPercent: number
}

export interface TimelineBlock extends ActivityBlock {
  segmentStartTs: number
  segmentEndTs: number
  leftPercent: number
  widthPercent: number
  visibleTitleSegments: TimelineTitleSegment[]
}

export interface TimelineRange {
  startHour: number
  endHour: number
  blocks: TimelineBlock[]
}

export interface UsageItem {
  key: string
  app: string
  durationMs: number
  ratio: number
  details: UsageDetail[]
}

export interface UsageDetail {
  id: number
  title: string | null
  startTs: number
  endTs: number
  durationMs: number
}

export interface AppPalette {
  main: string
  surface: string
  text: string
}

const APP_PALETTES: AppPalette[] = [
  { main: '#3478df', surface: '#dceaff', text: '#1455b8' },
  { main: '#22a9a5', surface: '#d9f1ef', text: '#147d79' },
  { main: '#7eb64d', surface: '#e5f1d9', text: '#527f2d' },
  { main: '#9259e8', surface: '#eadffd', text: '#6d35c7' },
  { main: '#d16b68', surface: '#f8e1df', text: '#a84542' },
  { main: '#d49735', surface: '#f8ead2', text: '#99671b' },
]

const IDLE_PALETTE: AppPalette = {
  main: '#a6a6aa',
  surface: '#e6e6e8',
  text: '#66666c',
}

function isIdleEvent(event: Pick<ActivityEvent, 'app' | 'bundle_id'>): boolean {
  return event.app === '(空闲)' || (!event.bundle_id && event.app === '系统空闲')
}

export function appKey(
  event: Pick<ActivityEvent, 'app' | 'bundle_id'>,
): string {
  if (isIdleEvent(event)) return '__system_idle__'
  return event.bundle_id.trim() || `app:${event.app}`
}

export function displayAppName(
  event: Pick<ActivityEvent, 'app' | 'bundle_id'>,
): string {
  return isIdleEvent(event) ? '系统空闲' : event.app
}

function appendTitleSegment(
  segments: TitleSegment[],
  event: ActivityEvent,
): void {
  const title = event.window_title?.trim() || null
  const previous = segments.at(-1)
  if (
    previous &&
    previous.title === title &&
    previous.endTs === event.start_ts
  ) {
    previous.endTs = event.end_ts
    return
  }
  segments.push({
    startTs: event.start_ts,
    endTs: event.end_ts,
    title,
  })
}

export function buildActivityBlocks(
  events: ActivityEvent[],
  minimumDurationSeconds = MIN_ACTIVITY_DURATION_SECONDS,
): ActivityBlock[] {
  const sorted = events
    .filter((event) => event.end_ts > event.start_ts)
    .toSorted(
      (left, right) =>
        left.start_ts - right.start_ts || left.end_ts - right.end_ts,
    )

  const blocks: ActivityBlock[] = []
  for (const event of sorted) {
    const key = appKey(event)
    const previous = blocks.at(-1)
    if (
      previous &&
      previous.key === key &&
      previous.endTs === event.start_ts
    ) {
      previous.endTs = event.end_ts
      appendTitleSegment(previous.titleSegments, event)
      continue
    }

    const block: ActivityBlock = {
      key,
      app: displayAppName(event),
      startTs: event.start_ts,
      endTs: event.end_ts,
      titleSegments: [],
    }
    appendTitleSegment(block.titleSegments, event)
    blocks.push(block)
  }

  return blocks.filter(
    (block) => block.endTs - block.startTs >= minimumDurationSeconds,
  )
}

export function splitIntoTimelineRanges(
  blocks: ActivityBlock[],
  dayStartTs: number,
): TimelineRange[] {
  return [0, 1].map((rangeIndex) => {
    const rangeStart = dayStartTs + rangeIndex * HALF_DAY_SECONDS
    const rangeEnd = rangeStart + HALF_DAY_SECONDS
    const timelineBlocks = blocks.flatMap<TimelineBlock>((block) => {
      const segmentStartTs = Math.max(block.startTs, rangeStart)
      const segmentEndTs = Math.min(block.endTs, rangeEnd)
      if (segmentEndTs <= segmentStartTs) return []

      const segmentDuration = segmentEndTs - segmentStartTs
      const visibleTitleSegments = block.titleSegments.flatMap<TimelineTitleSegment>(
        (titleSegment) => {
          const startTs = Math.max(titleSegment.startTs, segmentStartTs)
          const endTs = Math.min(titleSegment.endTs, segmentEndTs)
          if (endTs <= startTs) return []
          return [
            {
              ...titleSegment,
              startTs,
              endTs,
              leftPercent:
                ((startTs - segmentStartTs) / segmentDuration) * 100,
              widthPercent: ((endTs - startTs) / segmentDuration) * 100,
            },
          ]
        },
      )

      return [
        {
          ...block,
          segmentStartTs,
          segmentEndTs,
          leftPercent:
            ((segmentStartTs - rangeStart) / HALF_DAY_SECONDS) * 100,
          widthPercent:
            ((segmentEndTs - segmentStartTs) / HALF_DAY_SECONDS) * 100,
          visibleTitleSegments,
        },
      ]
    })

    return {
      startHour: rangeIndex * 12,
      endHour: rangeIndex * 12 + 12,
      blocks: timelineBlocks,
    }
  })
}

export function aggregateUsage(events: ActivityEvent[]): UsageItem[] {
  const totals = new Map<
    string,
    { app: string; durationMs: number; details: UsageDetail[] }
  >()
  let totalDurationMs = 0

  for (const event of events) {
    if (event.end_ts <= event.start_ts) continue
    const durationMs = Math.max(
      0,
      event.duration_ms || (event.end_ts - event.start_ts) * 1000,
    )
    if (durationMs === 0) continue

    const key = appKey(event)
    const existing = totals.get(key)
    const detail: UsageDetail = {
      id: event.id,
      title: event.window_title?.trim() || null,
      startTs: event.start_ts,
      endTs: event.end_ts,
      durationMs,
    }
    if (existing) {
      existing.durationMs += durationMs
      existing.details.push(detail)
    } else {
      totals.set(key, {
        app: displayAppName(event),
        durationMs,
        details: [detail],
      })
    }
    totalDurationMs += durationMs
  }

  return [...totals.entries()]
    .map(([key, value]) => ({
      key,
      app: value.app,
      durationMs: value.durationMs,
      ratio: totalDurationMs > 0 ? value.durationMs / totalDurationMs : 0,
      details: value.details.toSorted(
        (left, right) =>
          right.durationMs - left.durationMs ||
          left.startTs - right.startTs ||
          left.endTs - right.endTs,
      ),
    }))
    .toSorted(
      (left, right) =>
        right.durationMs - left.durationMs || left.app.localeCompare(right.app),
    )
}

export function hasOverlappingEvents(events: ActivityEvent[]): boolean {
  const sorted = events
    .filter((event) => event.end_ts > event.start_ts)
    .toSorted(
      (left, right) =>
        left.start_ts - right.start_ts || left.end_ts - right.end_ts,
    )
  let latestEnd = Number.NEGATIVE_INFINITY
  for (const event of sorted) {
    if (event.start_ts < latestEnd) return true
    latestEnd = Math.max(latestEnd, event.end_ts)
  }
  return false
}

function stableHash(value: string): number {
  let hash = 0
  for (const character of value) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  }
  return hash
}

export function getAppPalette(key: string, app: string): AppPalette {
  if (key === '__system_idle__') return IDLE_PALETTE
  const identity = `${key} ${app}`.toLowerCase()
  if (identity.includes('xcode')) return APP_PALETTES[0]
  if (identity.includes('chatgpt') || identity.includes('openai')) {
    return APP_PALETTES[1]
  }
  if (identity.includes('wechat') || identity.includes('微信')) {
    return APP_PALETTES[2]
  }
  if (identity.includes('sourcetree')) return APP_PALETTES[3]
  return APP_PALETTES[stableHash(key) % APP_PALETTES.length]
}

export function mixWithWhite(color: string, whiteRatio: number): string {
  const value = color.replace('#', '')
  const ratio = Math.min(1, Math.max(0, whiteRatio))
  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(value.slice(offset, offset + 2), 16),
  )
  const mixed = channels.map((channel) =>
    Math.round(channel + (255 - channel) * ratio)
      .toString(16)
      .padStart(2, '0'),
  )
  return `#${mixed.join('')}`
}

export function localDayStartTs(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(new Date(year, month - 1, day).getTime() / 1000)
}

export function todayString(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return seconds === '00'
    ? `${hours}:${minutes}`
    : `${hours}:${minutes}:${seconds}`
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`
}

export function formatPercentage(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`
}
