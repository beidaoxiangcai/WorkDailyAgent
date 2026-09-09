#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import process from 'node:process'

let DatabaseSync
try {
  const sqlite = await import('node:sqlite')
  DatabaseSync = sqlite.DatabaseSync
} catch {
  // doctor 仍需在不支持 node:sqlite 的旧版 Node.js 上输出可读诊断。
}

const APP_IDENTIFIER = 'com.workdaily.agent'
const REPOSITORY_URL = 'https://github.com/beidaoxiangcai/WorkDailyAgent.git'
const MINIMUM_NODE = [22, 12, 0]
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = resolve(SCRIPT_DIR, '..')
const DEFAULT_TEMPLATE_PATH = join(SKILL_DIR, 'assets', 'default-timeline.html')
const DEFAULT_RANGE_TEMPLATE_PATH = join(SKILL_DIR, 'assets', 'default-range-timeline.html')
const RANGE_RENDERER_PATH = join(SKILL_DIR, 'assets', 'range-renderer.js')
const APP_DATA_DIR = process.env.WORKDAILY_APP_DATA_DIR
  ? resolve(process.env.WORKDAILY_APP_DATA_DIR)
  : join(homedir(), 'Library', 'Application Support', APP_IDENTIFIER)
const DEFAULT_DB_PATH = process.env.WORKDAILY_DB_PATH
  ? resolve(process.env.WORKDAILY_DB_PATH)
  : join(APP_DATA_DIR, 'workdaily.db')
const SOCKET_PATH = join(APP_DATA_DIR, 'workdaily-agent.sock')
const TEMPLATES_DIR = join(APP_DATA_DIR, 'templates')
const EXPORTS_DIR = join(APP_DATA_DIR, 'exports')
const MANAGED_SOURCE_DIR = join(APP_DATA_DIR, 'source')
const TEMPLATE_PLACEHOLDER = '{{WORKDAILY_DATA_JSON}}'
const RANGE_TEMPLATE_PLACEHOLDER = '{{WORKDAILY_RANGE_JSON}}'
const RANGE_CHUNK_DAYS = 7
const REPORT_EVENT_FIELDS = [
  'start_ts',
  'end_ts',
  'app',
  'window_title',
  'duration_ms',
  'ongoing',
]
const REPORT_DAY_FIELDS = [
  'date',
  'live',
  'source',
  'warning',
  'event_count',
  'recorded_duration_ms',
]
const REPORT_AGGREGATE_FIELDS = [
  'app',
  'window_title',
  'duration_ms',
  'event_count',
  'active_days',
  'first_ts',
  'last_ts',
]

const BOOLEAN_OPTIONS = new Set([
  'json',
  'no-open',
  'set-default',
  'expand-all',
  'collapse-all',
  'stdin',
  'no-export',
  'yes',
  'help',
])

function parseArgs(args) {
  const options = {}
  const positionals = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const [rawKey, inlineValue] = value.slice(2).split('=', 2)
    if (BOOLEAN_OPTIONS.has(rawKey)) {
      options[rawKey] = inlineValue === undefined ? true : inlineValue !== 'false'
      continue
    }
    const nextValue = inlineValue ?? args[index + 1]
    if (nextValue === undefined || nextValue.startsWith('--')) {
      fail(`选项 --${rawKey} 缺少参数`)
    }
    options[rawKey] = nextValue
    if (inlineValue === undefined) index += 1
  }
  return { options, positionals }
}

function fail(message, exitCode = 1) {
  const error = new Error(message)
  error.exitCode = exitCode
  throw error
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printCompactJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function formatToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function normalizeDate(value = 'today') {
  if (value === 'today') return formatToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`无效日期：${value}，请使用 YYYY-MM-DD 或 today`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail(`无效日期：${value}`)
  }
  return value
}

function shanghaiDayRange(date) {
  const startTs = Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1000)
  return [startTs, startTs + 86_400]
}

function addDays(date, amount) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day + amount))
  return [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-')
}

function daysBetween(from, to) {
  const [fromStart] = shanghaiDayRange(from)
  const [toStart] = shanghaiDayRange(to)
  return Math.round((toStart - fromStart) / 86_400)
}

function resolveDateSelection(options) {
  const hasRange = options.from !== undefined || options.to !== undefined
  if (hasRange && options.date !== undefined) {
    fail('--date 不能与 --from/--to 同时使用')
  }
  if (!hasRange) return { kind: 'day', date: normalizeDate(options.date) }
  if (options.from === undefined || options.to === undefined) {
    fail('多日查询必须同时提供 --from 和 --to')
  }
  const from = normalizeDate(options.from)
  const to = normalizeDate(options.to)
  if (from > to) fail(`开始日期不能晚于结束日期：${from} > ${to}`)
  return { kind: 'range', from, to, day_count: daysBetween(from, to) + 1 }
}

function datesInRange(from, to) {
  const dates = []
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date)
  return dates
}

function chunkDateRange(from, to, chunkDays = RANGE_CHUNK_DAYS) {
  const chunks = []
  for (let chunkFrom = from; chunkFrom <= to; chunkFrom = addDays(chunkFrom, chunkDays)) {
    const candidateTo = addDays(chunkFrom, chunkDays - 1)
    chunks.push({ from: chunkFrom, to: candidateTo < to ? candidateTo : to })
  }
  return chunks
}

function commandAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return !result.error && result.status === 0
}

function nodeVersionSupported() {
  const current = process.versions.node.split('.').map(Number)
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (current[index] > MINIMUM_NODE[index]) return true
    if (current[index] < MINIMUM_NODE[index]) return false
  }
  return true
}

function findProjectRoot() {
  const candidates = [
    process.env.WORKDAILY_SOURCE_DIR && resolve(process.env.WORKDAILY_SOURCE_DIR),
    resolve(SKILL_DIR, '..', '..'),
    process.cwd(),
    MANAGED_SOURCE_DIR,
  ].filter(Boolean)
  return candidates.find(
    (candidate) =>
      existsSync(join(candidate, 'package.json')) &&
      existsSync(join(candidate, 'package-lock.json')) &&
      existsSync(join(candidate, 'src-tauri', 'tauri.conf.json')),
  ) ?? null
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
  })
  if (result.error) fail(`${command} 执行失败：${result.error.message}`)
  if (result.status !== 0) fail(`${command} 执行失败，退出码 ${result.status}`)
}

function cloneManagedSource() {
  if (existsSync(MANAGED_SOURCE_DIR)) {
    fail(`托管源码目录已存在但不是有效项目：${MANAGED_SOURCE_DIR}`)
  }
  mkdirSync(dirname(MANAGED_SOURCE_DIR), { recursive: true })
  run('git', ['clone', '--depth', '1', REPOSITORY_URL, MANAGED_SOURCE_DIR])
  writeFileSync(
    join(MANAGED_SOURCE_DIR, '.workdaily-managed-source'),
    `${REPOSITORY_URL}\n`,
    { mode: 0o600 },
  )
  return MANAGED_SOURCE_DIR
}

function ensureProjectDependencies(projectRoot) {
  const tauriBin = join(projectRoot, 'node_modules', '.bin', 'tauri')
  if (existsSync(tauriBin)) return
  process.stderr.write('正在安装项目依赖，首次执行需要一些时间…\n')
  run('npm', ['ci', '--include=dev'], { cwd: projectRoot })
}

function appBuildEnvironment() {
  const targetDir = join(APP_DATA_DIR, 'build', 'target')
  mkdirSync(targetDir, { recursive: true })
  return { ...process.env, CARGO_TARGET_DIR: targetDir }
}

async function requestRunningApp(payload, timeoutMs = 700) {
  if (!existsSync(SOCKET_PATH)) return null
  return new Promise((resolveRequest) => {
    const socket = net.createConnection(SOCKET_PATH)
    let response = ''
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveRequest(value)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => socket.end(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => {
      response += chunk
      if (response.length > 2_000_000) settle(null)
    })
    socket.on('end', () => {
      try {
        const parsed = JSON.parse(response)
        settle(parsed.ok ? parsed.data : null)
      } catch {
        settle(null)
      }
    })
    socket.on('timeout', () => settle(null))
    socket.on('error', () => settle(null))
  })
}

function openDatabase(dbPath, readOnly = true) {
  if (!DatabaseSync) {
    fail('当前 Node.js 不支持 node:sqlite，请升级到 Node.js 22.12.0 或更高版本')
  }
  if (!existsSync(dbPath)) {
    fail(`未找到 WorkDailyAgent 数据库：${dbPath}\n请先启动应用并产生工作记录。`)
  }
  const database = new DatabaseSync(dbPath, { readOnly })
  database.exec('PRAGMA busy_timeout = 3000')
  return database
}

function isIdleEvent(event) {
  return event.app === '(空闲)' || (!event.bundle_id && event.app === '系统空闲')
}

function mergeRanges(ranges) {
  const sorted = ranges
    .filter(([start, end]) => end > start)
    .toSorted((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], range[1])
    } else {
      merged.push([...range])
    }
  }
  return merged
}

function subtractRanges(start, end, occupied) {
  let cursor = start
  const remaining = []
  for (const [occupiedStart, occupiedEnd] of occupied) {
    if (occupiedEnd <= cursor) continue
    if (occupiedStart >= end) break
    if (occupiedStart > cursor) remaining.push([cursor, Math.min(occupiedStart, end)])
    cursor = Math.max(cursor, occupiedEnd)
    if (cursor >= end) return remaining
  }
  if (cursor < end) remaining.push([cursor, end])
  return remaining
}

function normalizeIdleEvents(events) {
  const regular = events.filter((event) => !isIdleEvent(event))
  const idle = events
    .filter(isIdleEvent)
    .toSorted((left, right) => left.start_ts - right.start_ts || left.end_ts - right.end_ts)
  if (idle.length === 0) return regular

  const occupied = mergeRanges(regular.map((event) => [event.start_ts, event.end_ts]))
  const mergedIdle = []
  for (const event of idle) {
    const previous = mergedIdle.at(-1)
    if (previous && event.start_ts <= previous.end_ts) {
      previous.end_ts = Math.max(previous.end_ts, event.end_ts)
      previous.duration_ms = (previous.end_ts - previous.start_ts) * 1000
      previous.ongoing ||= event.ongoing
      if (previous.id <= 0 && event.id > 0) previous.id = event.id
    } else {
      mergedIdle.push({ ...event })
    }
  }

  for (const event of mergedIdle) {
    for (const [startTs, endTs] of subtractRanges(event.start_ts, event.end_ts, occupied)) {
      regular.push({
        ...event,
        start_ts: startTs,
        end_ts: endTs,
        duration_ms: (endTs - startTs) * 1000,
        ongoing: event.ongoing && endTs === event.end_ts,
      })
    }
  }
  return regular
}

function queryDatabaseEventsBetween(dbPath, startTs, endTs) {
  const database = openDatabase(dbPath)
  try {
    const rows = database.prepare(
      `SELECT id, start_ts, end_ts, app, bundle_id, window_title, duration_ms
       FROM events
       WHERE start_ts < ? AND end_ts > ?
       ORDER BY start_ts DESC`,
    ).all(endTs, startTs)
    const events = rows.map((row) => {
      const clippedStart = Math.max(Number(row.start_ts), startTs)
      const clippedEnd = Math.min(Number(row.end_ts), endTs)
      return {
        id: Number(row.id),
        start_ts: clippedStart,
        end_ts: clippedEnd,
        app: row.app,
        bundle_id: row.bundle_id,
        window_title: row.window_title,
        duration_ms: (clippedEnd - clippedStart) * 1000,
        ongoing: false,
      }
    })
    return normalizeIdleEvents(events).toSorted(
      (left, right) => right.start_ts - left.start_ts || right.end_ts - left.end_ts,
    )
  } finally {
    database.close()
  }
}

function queryDatabaseEvents(dbPath, date) {
  const [startTs, endTs] = shanghaiDayRange(date)
  return queryDatabaseEventsBetween(dbPath, startTs, endTs)
}

function splitEventsByDate(events, from, to) {
  const split = new Map(datesInRange(from, to).map((date) => [date, []]))
  for (const [date, dateEvents] of split) {
    const [dayStart, dayEnd] = shanghaiDayRange(date)
    for (const event of events) {
      const startTs = Math.max(event.start_ts, dayStart)
      const endTs = Math.min(event.end_ts, dayEnd)
      if (endTs <= startTs) continue
      dateEvents.push({
        ...event,
        start_ts: startTs,
        end_ts: endTs,
        duration_ms: (endTs - startTs) * 1000,
        ongoing: Boolean(event.ongoing && endTs === event.end_ts),
      })
    }
    dateEvents.sort((left, right) => right.start_ts - left.start_ts || right.end_ts - left.end_ts)
  }
  return split
}

async function queryEvents(options) {
  const date = normalizeDate(options.date)
  const dbPath = options.db ? resolve(options.db) : DEFAULT_DB_PATH
  if (!options.db) {
    const live = await requestRunningApp({ action: 'query_events', date })
    if (live?.events) {
      return { date, live: true, source: 'application', events: live.events }
    }
  }
  return {
    date,
    live: false,
    source: 'sqlite',
    warning: date === formatToday()
      ? '应用未运行或本机查询通道不可用，当前尚未结束的活动可能未包含。'
      : null,
    events: queryDatabaseEvents(dbPath, date),
  }
}

function compactUsage(usage) {
  return usage.map(({ key, app, duration_ms, ratio }) => ({ key, app, duration_ms, ratio }))
}

function contextHighlights(context, limit = 12) {
  return context.activity_blocks
    .map((block) => ({
      key: block.key,
      app: block.app,
      start_ts: block.start_ts,
      end_ts: block.end_ts,
      duration_ms: (block.end_ts - block.start_ts) * 1000,
      titles: block.titles
        .filter((title) => title.title)
        .map((title) => title.title)
        .filter((title, index, titles) => titles.indexOf(title) === index)
        .slice(0, 3),
    }))
    .toSorted((left, right) => right.duration_ms - left.duration_ms || left.start_ts - right.start_ts)
    .slice(0, limit)
}

function createRangeAccumulator(selection) {
  return {
    schema_version: 1,
    kind: 'range',
    from: selection.from,
    to: selection.to,
    timezone: 'Asia/Shanghai',
    chunk_days: RANGE_CHUNK_DAYS,
    chunk_count: chunkDateRange(selection.from, selection.to).length,
    generated_at: Math.floor(Date.now() / 1000),
    live: false,
    source: 'sqlite',
    warnings: [],
    totals: {
      day_count: selection.day_count,
      active_day_count: 0,
      event_count: 0,
      recorded_duration_ms: 0,
      application_count: 0,
    },
    usage: [],
    days: [],
    _usage: new Map(),
    _sources: new Set(),
  }
}

function addContextToRange(range, context) {
  range.live ||= context.live
  range._sources.add(context.source)
  if (context.warning && !range.warnings.includes(context.warning)) range.warnings.push(context.warning)
  range.totals.event_count += context.totals.event_count
  range.totals.recorded_duration_ms += context.totals.recorded_duration_ms
  if (context.totals.event_count > 0) range.totals.active_day_count += 1
  for (const item of context.usage) {
    const current = range._usage.get(item.key) ?? { key: item.key, app: item.app, duration_ms: 0 }
    current.duration_ms += item.duration_ms
    range._usage.set(item.key, current)
  }
  range.days.push({
    date: context.date,
    live: context.live,
    source: context.source,
    warning: context.warning,
    totals: context.totals,
    usage: compactUsage(context.usage),
    activity_block_count: context.activity_blocks.length,
    highlights: contextHighlights(context),
  })
}

function finishRange(range) {
  const totalDurationMs = range.totals.recorded_duration_ms
  range.usage = [...range._usage.values()]
    .map((item) => ({
      ...item,
      ratio: totalDurationMs > 0 ? item.duration_ms / totalDurationMs : 0,
    }))
    .toSorted((left, right) => right.duration_ms - left.duration_ms || left.app.localeCompare(right.app))
  range.totals.application_count = range.usage.length
  range.source = range._sources.size > 1 ? 'mixed' : [...range._sources][0] ?? 'sqlite'
  delete range._usage
  delete range._sources
  return range
}

async function processDateRange(options, selection, onDay = null) {
  const dbPath = options.db ? resolve(options.db) : DEFAULT_DB_PATH
  const today = formatToday()
  const range = createRangeAccumulator(selection)
  let liveToday = null
  if (!options.db && selection.from <= today && today <= selection.to) {
    const response = await requestRunningApp({ action: 'query_events', date: today })
    if (response?.events) {
      liveToday = { date: today, live: true, source: 'application', events: response.events }
    }
  }

  for (const chunk of chunkDateRange(selection.from, selection.to)) {
    const [chunkStart] = shanghaiDayRange(chunk.from)
    const [, chunkEnd] = shanghaiDayRange(chunk.to)
    const splitEvents = splitEventsByDate(
      queryDatabaseEventsBetween(dbPath, chunkStart, chunkEnd),
      chunk.from,
      chunk.to,
    )
    for (const date of datesInRange(chunk.from, chunk.to)) {
      const queryResult = date === today && liveToday
        ? liveToday
        : {
            date,
            live: false,
            source: 'sqlite',
            warning: date === today
              ? '应用未运行或本机查询通道不可用，当前尚未结束的活动可能未包含。'
              : null,
            events: splitEvents.get(date) ?? [],
          }
      const context = buildContext(queryResult)
      if (onDay) await onDay(context)
      addContextToRange(range, context)
    }
  }
  return finishRange(range)
}

function appKey(event) {
  if (isIdleEvent(event)) return '__system_idle__'
  return event.bundle_id.trim() || `app:${event.app}`
}

function displayAppName(event) {
  return isIdleEvent(event) ? '系统空闲' : event.app
}

function buildActivityBlocks(events, minimumDurationSeconds = 30) {
  const sorted = events
    .filter((event) => event.end_ts > event.start_ts)
    .toSorted((left, right) => left.start_ts - right.start_ts || left.end_ts - right.end_ts)
  const blocks = []
  for (const event of sorted) {
    const key = appKey(event)
    const title = event.window_title?.trim() || null
    const previous = blocks.at(-1)
    if (previous && previous.key === key && previous.end_ts === event.start_ts) {
      previous.end_ts = event.end_ts
      const previousTitle = previous.titles.at(-1)
      if (previousTitle && previousTitle.title === title && previousTitle.end_ts === event.start_ts) {
        previousTitle.end_ts = event.end_ts
      } else {
        previous.titles.push({ start_ts: event.start_ts, end_ts: event.end_ts, title })
      }
      continue
    }
    blocks.push({
      key,
      app: displayAppName(event),
      start_ts: event.start_ts,
      end_ts: event.end_ts,
      titles: [{ start_ts: event.start_ts, end_ts: event.end_ts, title }],
    })
  }
  return blocks.filter((block) => block.end_ts - block.start_ts >= minimumDurationSeconds)
}

function aggregateUsage(events) {
  const totals = new Map()
  let totalDurationMs = 0
  for (const event of events) {
    if (event.end_ts <= event.start_ts) continue
    const durationMs = Math.max(0, event.duration_ms || (event.end_ts - event.start_ts) * 1000)
    if (durationMs === 0) continue
    const key = appKey(event)
    const value = totals.get(key) ?? {
      key,
      app: displayAppName(event),
      duration_ms: 0,
      details: [],
    }
    value.duration_ms += durationMs
    value.details.push({
      id: event.id,
      title: event.window_title?.trim() || null,
      start_ts: event.start_ts,
      end_ts: event.end_ts,
      duration_ms: durationMs,
    })
    totals.set(key, value)
    totalDurationMs += durationMs
  }
  return [...totals.values()]
    .map((value) => ({
      ...value,
      ratio: totalDurationMs > 0 ? value.duration_ms / totalDurationMs : 0,
      details: value.details.toSorted(
        (left, right) =>
          right.duration_ms - left.duration_ms ||
          left.start_ts - right.start_ts ||
          left.end_ts - right.end_ts,
      ),
    }))
    .toSorted((left, right) => right.duration_ms - left.duration_ms || left.app.localeCompare(right.app))
}

function reportEvent(event) {
  return [
    event.start_ts,
    event.end_ts,
    event.app,
    event.window_title?.trim() || null,
    Math.max(0, event.duration_ms || (event.end_ts - event.start_ts) * 1000),
    Boolean(event.ongoing),
  ]
}

function buildDayReportContext(result) {
  const sourceEvents = result.events
    .filter((event) => event.end_ts > event.start_ts)
    .toSorted((left, right) => left.start_ts - right.start_ts || left.end_ts - right.end_ts)
  const events = sourceEvents.map(reportEvent)
  return {
    schema_version: 1,
    kind: 'day',
    input_mode: 'raw_events',
    date: result.date,
    timezone: 'Asia/Shanghai',
    live: result.live,
    source: result.source,
    warning: result.warning ?? null,
    generated_at: Math.floor(Date.now() / 1000),
    event_fields: REPORT_EVENT_FIELDS,
    totals: {
      event_count: events.length,
      recorded_duration_ms: events.reduce((total, event) => total + event[4], 0),
      application_count: new Set(sourceEvents.map(appKey)).size,
    },
    events,
  }
}

function addReportAggregate(groups, event, date) {
  if (event.end_ts <= event.start_ts) return
  const durationMs = Math.max(0, event.duration_ms || (event.end_ts - event.start_ts) * 1000)
  if (durationMs === 0) return
  const title = event.window_title?.trim() || null
  const key = JSON.stringify([appKey(event), title])
  const current = groups.get(key) ?? {
    _key: key,
    _dates: new Set(),
    app: displayAppName(event),
    window_title: title,
    duration_ms: 0,
    event_count: 0,
    first_ts: event.start_ts,
    last_ts: event.end_ts,
  }
  current.duration_ms += durationMs
  current.event_count += 1
  current.first_ts = Math.min(current.first_ts, event.start_ts)
  current.last_ts = Math.max(current.last_ts, event.end_ts)
  current._dates.add(date)
  groups.set(key, current)
}

function mergeReportAggregates(target, source) {
  for (const item of source.values()) {
    const current = target.get(item._key)
    if (!current) {
      target.set(item._key, item)
      continue
    }
    current.duration_ms += item.duration_ms
    current.event_count += item.event_count
    current.first_ts = Math.min(current.first_ts, item.first_ts)
    current.last_ts = Math.max(current.last_ts, item.last_ts)
    for (const date of item._dates) current._dates.add(date)
  }
}

async function buildRangeReportContext(options, selection) {
  const dbPath = options.db ? resolve(options.db) : DEFAULT_DB_PATH
  const today = formatToday()
  const groups = new Map()
  const applicationKeys = new Set()
  const sources = new Set()
  const warnings = []
  const days = []
  let live = false
  let eventCount = 0
  let recordedDurationMs = 0
  let activeDayCount = 0
  let liveToday = null

  if (!options.db && selection.from <= today && today <= selection.to) {
    const response = await requestRunningApp({ action: 'query_events', date: today })
    if (response?.events) {
      liveToday = { date: today, live: true, source: 'application', events: response.events }
    }
  }

  for (const chunk of chunkDateRange(selection.from, selection.to)) {
    const [chunkStart] = shanghaiDayRange(chunk.from)
    const [, chunkEnd] = shanghaiDayRange(chunk.to)
    const splitEvents = splitEventsByDate(
      queryDatabaseEventsBetween(dbPath, chunkStart, chunkEnd),
      chunk.from,
      chunk.to,
    )
    const chunkGroups = new Map()

    for (const date of datesInRange(chunk.from, chunk.to)) {
      const result = date === today && liveToday
        ? liveToday
        : {
            date,
            live: false,
            source: 'sqlite',
            warning: date === today
              ? '应用未运行或本机查询通道不可用，当前尚未结束的活动可能未包含。'
              : null,
            events: splitEvents.get(date) ?? [],
          }
      const events = result.events.filter((event) => event.end_ts > event.start_ts)
      const dayDurationMs = events.reduce(
        (total, event) => total + Math.max(0, event.duration_ms || (event.end_ts - event.start_ts) * 1000),
        0,
      )
      live ||= result.live
      sources.add(result.source)
      if (result.warning && !warnings.includes(result.warning)) warnings.push(result.warning)
      eventCount += events.length
      recordedDurationMs += dayDurationMs
      if (events.length > 0) activeDayCount += 1
      for (const event of events) {
        applicationKeys.add(appKey(event))
        addReportAggregate(chunkGroups, event, date)
      }
      days.push([
        date,
        result.live,
        result.source,
        result.warning ?? null,
        events.length,
        dayDurationMs,
      ])
    }

    mergeReportAggregates(groups, chunkGroups)
  }

  const aggregates = [...groups.values()]
    .map(({ _dates, app, window_title, duration_ms, event_count, first_ts, last_ts }) => [
      app,
      window_title,
      duration_ms,
      event_count,
      _dates.size,
      first_ts,
      last_ts,
    ])
    .toSorted((left, right) =>
      right[2] - left[2] ||
      left[0].localeCompare(right[0]) ||
      String(left[1]).localeCompare(String(right[1])),
    )

  return {
    schema_version: 1,
    kind: 'range',
    input_mode: 'app_title_aggregates',
    from: selection.from,
    to: selection.to,
    timezone: 'Asia/Shanghai',
    chunk_days: RANGE_CHUNK_DAYS,
    chunk_count: chunkDateRange(selection.from, selection.to).length,
    generated_at: Math.floor(Date.now() / 1000),
    live,
    source: sources.size > 1 ? 'mixed' : [...sources][0] ?? 'sqlite',
    warnings,
    day_fields: REPORT_DAY_FIELDS,
    aggregate_fields: REPORT_AGGREGATE_FIELDS,
    totals: {
      day_count: selection.day_count,
      active_day_count: activeDayCount,
      event_count: eventCount,
      recorded_duration_ms: recordedDurationMs,
      application_count: applicationKeys.size,
      aggregate_count: aggregates.length,
    },
    days,
    aggregates,
  }
}

function buildContext(result) {
  const chronologicalEvents = result.events.toSorted(
    (left, right) => left.start_ts - right.start_ts || left.end_ts - right.end_ts,
  )
  const usage = aggregateUsage(chronologicalEvents)
  return {
    schema_version: 1,
    date: result.date,
    timezone: 'Asia/Shanghai',
    live: result.live,
    source: result.source,
    warning: result.warning ?? null,
    generated_at: Math.floor(Date.now() / 1000),
    totals: {
      event_count: chronologicalEvents.length,
      recorded_duration_ms: chronologicalEvents.reduce(
        (total, event) => total + event.duration_ms,
        0,
      ),
      application_count: usage.length,
    },
    events: chronologicalEvents,
    activity_blocks: buildActivityBlocks(chronologicalEvents),
    usage,
  }
}

function templateConfiguration() {
  const configPath = join(TEMPLATES_DIR, 'config.json')
  const defaults = {
    default_timeline_style: 'default',
    default_range_timeline_style: 'default',
  }
  if (!existsSync(configPath)) return defaults
  try {
    return { ...defaults, ...JSON.parse(readFileSync(configPath, 'utf8')) }
  } catch {
    return defaults
  }
}

function saveTemplateConfiguration(config) {
  mkdirSync(TEMPLATES_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(join(TEMPLATES_DIR, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  })
}

function validateStyleName(name) {
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    fail('样式名称只能包含小写字母、数字和连字符，最长 64 个字符')
  }
  if (name === 'default') fail('default 是内置样式名称，不能覆盖')
  return name
}

function resolveTemplate(styleName) {
  if (styleName === 'default') return DEFAULT_TEMPLATE_PATH
  const customPath = join(TEMPLATES_DIR, styleName, 'template.html')
  if (!existsSync(customPath)) fail(`未找到样式：${styleName}`)
  return customPath
}

function resolveRangeTemplate(styleName) {
  if (styleName === 'default') return DEFAULT_RANGE_TEMPLATE_PATH
  const customPath = join(TEMPLATES_DIR, styleName, 'range-template.html')
  if (!existsSync(customPath)) fail(`样式 ${styleName} 没有多日行为轨迹模板`)
  return customPath
}

function renderTemplate(template, context) {
  const parts = template.split(TEMPLATE_PLACEHOLDER)
  if (parts.length !== 2) {
    fail(`HTML 模板必须且只能包含一个 ${TEMPLATE_PLACEHOLDER} 占位符`)
  }
  const safeJson = JSON.stringify(context).replaceAll('<', '\\u003c')
  return `${parts[0]}${safeJson}${parts[1]}`
}

function renderRangeTemplate(template, context) {
  const parts = template.split(RANGE_TEMPLATE_PLACEHOLDER)
  if (parts.length !== 2) {
    fail(`多日 HTML 模板必须且只能包含一个 ${RANGE_TEMPLATE_PLACEHOLDER} 占位符`)
  }
  const safeJson = JSON.stringify(context).replaceAll('<', '\\u003c')
  return `${parts[0]}${safeJson}${parts[1]}`
}

function outputPath(options, date, fallbackName) {
  if (options.output) return resolve(options.output)
  return join(EXPORTS_DIR, date, fallbackName)
}

function rangeOutputDirectory(options, selection, kind) {
  if (options.output) return resolve(options.output)
  return join(EXPORTS_DIR, `${selection.from}-to-${selection.to}`, kind)
}

function writePrivateFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, content, { mode: 0o600 })
}

function safeJavaScriptJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', String.raw`\u2028`)
    .replaceAll('\u2029', String.raw`\u2029`)
}

function writeRangeDayScript(directory, context) {
  const payload = safeJavaScriptJson(context)
  writePrivateFile(
    join(directory, 'data', `${context.date}.js`),
    `window.WorkDailyRangeData.register(${JSON.stringify(context.date)},${payload});\n`,
  )
}

function writeRangeDayJson(directory, context, content = context) {
  writePrivateFile(
    join(directory, 'days', `${context.date}.json`),
    `${JSON.stringify(content, null, 2)}\n`,
  )
}

function openLocalFile(filePath) {
  const child = spawn('open', [filePath], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function commandDoctor(options) {
  const projectRoot = findProjectRoot()
  const appResponse = await requestRunningApp({ action: 'ping' })
  const checks = {
    platform: { ok: process.platform === 'darwin', value: process.platform },
    node: { ok: nodeVersionSupported(), value: process.versions.node },
    npm: { ok: commandAvailable('npm'), value: 'npm' },
    git: { ok: commandAvailable('git'), value: 'git' },
    cargo: { ok: commandAvailable('cargo'), value: 'cargo' },
    rustc: { ok: commandAvailable('rustc'), value: 'rustc' },
    xcode_tools: { ok: commandAvailable('xcode-select', ['-p']), value: 'xcode-select' },
    project_source: { ok: Boolean(projectRoot), value: projectRoot },
    database: { ok: existsSync(DEFAULT_DB_PATH), value: DEFAULT_DB_PATH },
    application_bridge: { ok: Boolean(appResponse), value: SOCKET_PATH },
  }
  const ok = ['platform', 'node', 'npm', 'git'].every((key) => checks[key].ok)
  const result = { ok, checks }
  if (options.json) return printJson(result)
  for (const [name, check] of Object.entries(checks)) {
    process.stdout.write(`${check.ok ? '✓' : '✗'} ${name}: ${check.value ?? '未找到'}\n`)
  }
  if (!ok) process.exitCode = 1
}

function commandSetup() {
  if (process.platform !== 'darwin') fail('WorkDailyAgent 当前只支持 macOS 12 及以上版本')
  if (!nodeVersionSupported()) fail('需要 Node.js 22.12.0 或更高版本')
  if (!commandAvailable('git')) fail('未找到 Git，请先安装 Xcode Command Line Tools')
  if (!commandAvailable('cargo') || !commandAvailable('rustc')) {
    fail('未找到 Rust 工具链，请先安装 rustup')
  }
  const projectRoot = findProjectRoot() ?? cloneManagedSource()
  ensureProjectDependencies(projectRoot)
  process.stdout.write(`项目已准备：${projectRoot}\n`)
  return projectRoot
}

function commandStart(build = false) {
  const projectRoot = findProjectRoot() ?? commandSetup()
  ensureProjectDependencies(projectRoot)
  const args = ['run', 'tauri', build ? 'build' : 'dev']
  run('npm', args, { cwd: projectRoot, env: appBuildEnvironment() })
}

async function commandEvents(options) {
  const selection = resolveDateSelection(options)
  if (selection.kind === 'range') {
    const directory = rangeOutputDirectory(options, selection, 'events')
    const range = await processDateRange(options, selection, (context) => {
      writeRangeDayJson(directory, context, {
        date: context.date,
        live: context.live,
        source: context.source,
        warning: context.warning,
        events: context.events,
      })
    })
    range.days.forEach((day) => { day.data_path = `days/${day.date}.json` })
    const manifestPath = join(directory, 'manifest.json')
    writePrivateFile(manifestPath, `${JSON.stringify(range, null, 2)}\n`)
    return printJson({
      ok: true,
      kind: 'range',
      from: selection.from,
      to: selection.to,
      chunk_days: RANGE_CHUNK_DAYS,
      chunk_count: range.chunk_count,
      event_count: range.totals.event_count,
      path: manifestPath,
      directory,
    })
  }
  const result = await queryEvents(options)
  printJson(result)
}

async function commandContext(options) {
  const selection = resolveDateSelection(options)
  if (selection.kind === 'range') {
    const detail = options.detail ?? 'summary'
    if (!['summary', 'full'].includes(detail)) fail('--detail 只支持 summary 或 full')
    if (detail === 'summary') {
      const range = await processDateRange(options, selection)
      return printJson({ ...range, detail })
    }
    const directory = rangeOutputDirectory(options, selection, 'context')
    const range = await processDateRange(options, selection, (context) => {
      writeRangeDayJson(directory, context)
    })
    range.days.forEach((day) => { day.data_path = `days/${day.date}.json` })
    const manifestPath = join(directory, 'manifest.json')
    writePrivateFile(manifestPath, `${JSON.stringify({ ...range, detail }, null, 2)}\n`)
    return printJson({
      ok: true,
      kind: 'range',
      detail,
      from: selection.from,
      to: selection.to,
      chunk_days: RANGE_CHUNK_DAYS,
      chunk_count: range.chunk_count,
      path: manifestPath,
      directory,
    })
  }
  const result = buildContext(await queryEvents(options))
  printJson(result)
}

async function commandTimeline(positionals, options) {
  const action = positionals[0] ?? 'show'
  if (action !== 'show') fail(`未知 timeline 操作：${action}`)
  const selection = resolveDateSelection(options)
  if (selection.kind === 'range') {
    if (options['expand-all'] && options['collapse-all']) {
      fail('--expand-all 与 --collapse-all 不能同时使用')
    }
    const config = templateConfiguration()
    const style = options.template
      ? 'one-off-custom'
      : options.style ?? config.default_range_timeline_style ?? 'default'
    const templatePath = options.template ? resolve(options.template) : resolveRangeTemplate(style)
    const template = readFileSync(templatePath, 'utf8')
    const directory = rangeOutputDirectory(options, selection, 'behavior-timeline')
    const range = await processDateRange(options, selection, (context) => {
      writeRangeDayScript(directory, context)
    })
    range.days.forEach((day) => { day.data_path = `data/${day.date}.js` })
    const initialExpansion = options['expand-all']
      ? 'all'
      : options['collapse-all'] ? 'none' : selection.day_count <= RANGE_CHUNK_DAYS ? 'all' : 'none'
    const pageData = { ...range, style, initial_expansion: initialExpansion }
    const indexPath = join(directory, 'index.html')
    writePrivateFile(indexPath, renderRangeTemplate(template, pageData))
    writePrivateFile(join(directory, 'assets', 'renderer.js'), readFileSync(RANGE_RENDERER_PATH, 'utf8'))
    if (!options['no-open']) openLocalFile(indexPath)
    const result = {
      ok: true,
      kind: 'range',
      from: selection.from,
      to: selection.to,
      days: selection.day_count,
      chunk_days: RANGE_CHUNK_DAYS,
      chunk_count: range.chunk_count,
      style,
      live: range.live,
      initial_expansion: initialExpansion,
      path: indexPath,
      directory,
    }
    if (options.json) printJson(result)
    else process.stdout.write(`多日行为轨迹已生成：${indexPath}\n`)
    return
  }
  const context = buildContext(await queryEvents(options))
  const style = options.template
    ? 'one-off-custom'
    : options.style ?? templateConfiguration().default_timeline_style ?? 'default'
  const templatePath = options.template ? resolve(options.template) : resolveTemplate(style)
  const template = readFileSync(templatePath, 'utf8')
  const html = renderTemplate(template, { ...context, style })
  const filePath = outputPath(options, context.date, 'behavior-timeline.html')
  writePrivateFile(filePath, html)
  if (!options['no-open']) openLocalFile(filePath)
  const result = { ok: true, date: context.date, style, live: context.live, path: filePath }
  if (options.json) printJson(result)
  else process.stdout.write(`行为轨迹已生成：${filePath}\n`)
}

async function commandStyle(positionals, options) {
  const action = positionals[0] ?? 'list'
  if (action === 'list') {
    const config = templateConfiguration()
    const styles = [{
      name: 'default',
      built_in: true,
      scopes: ['timeline', 'timeline-range'],
      is_default: config.default_timeline_style === 'default' ||
        config.default_range_timeline_style === 'default',
      is_default_day: config.default_timeline_style === 'default',
      is_default_range: config.default_range_timeline_style === 'default',
    }]
    if (existsSync(TEMPLATES_DIR)) {
      for (const entry of readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const manifestPath = join(TEMPLATES_DIR, entry.name, 'manifest.json')
        if (!existsSync(manifestPath)) continue
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          styles.push({
            ...manifest,
            is_default: entry.name === config.default_timeline_style ||
              entry.name === config.default_range_timeline_style,
            is_default_day: entry.name === config.default_timeline_style,
            is_default_range: entry.name === config.default_range_timeline_style,
          })
        } catch {
          styles.push({ name: entry.name, invalid: true, is_default: false })
        }
      }
    }
    return printJson(styles)
  }

  if (action === 'save') {
    const name = validateStyleName(options.name)
    if (!options.template) fail('style save 需要 --template <HTML文件>')
    const sourcePath = resolve(options.template)
    const template = readFileSync(sourcePath, 'utf8')
    const scope = options.scope ?? (template.includes(RANGE_TEMPLATE_PLACEHOLDER) ? 'range' : 'day')
    if (!['day', 'range'].includes(scope)) fail('--scope 只支持 day 或 range')
    if (scope === 'range') renderRangeTemplate(template, { validation: true })
    else renderTemplate(template, { validation: true })
    const styleDir = join(TEMPLATES_DIR, name)
    mkdirSync(styleDir, { recursive: true })
    writePrivateFile(join(styleDir, scope === 'range' ? 'range-template.html' : 'template.html'), template)
    const manifestPath = join(styleDir, 'manifest.json')
    let existing = {}
    if (existsSync(manifestPath)) {
      try {
        existing = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        existing = {}
      }
    }
    const scopes = new Set(existing.scopes ?? (existing.scope ? [existing.scope] : []))
    scopes.add(scope === 'range' ? 'timeline-range' : 'timeline')
    const manifest = {
      ...existing,
      name,
      scopes: [...scopes],
      schema_version: 1,
      renderer_version: scope === 'range' ? 2 : existing.renderer_version ?? 1,
      created_at: existing.created_at ?? Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    }
    writePrivateFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    if (options['set-default']) {
      const config = templateConfiguration()
      if (scope === 'range') config.default_range_timeline_style = name
      else config.default_timeline_style = name
      saveTemplateConfiguration(config)
    }
    return printJson({ ok: true, ...manifest, saved_scope: scope, is_default: Boolean(options['set-default']) })
  }

  if (action === 'set-default') {
    const name = positionals[1] ?? options.name
    if (!name) fail('style set-default 需要样式名称')
    const scope = options.scope ?? 'day'
    if (!['day', 'range'].includes(scope)) fail('--scope 只支持 day 或 range')
    if (scope === 'range') resolveRangeTemplate(name)
    else resolveTemplate(name)
    const config = templateConfiguration()
    if (scope === 'range') config.default_range_timeline_style = name
    else config.default_timeline_style = name
    saveTemplateConfiguration(config)
    return printJson({ ok: true, scope, default_timeline_style: name })
  }

  if (action === 'delete') {
    const name = validateStyleName(positionals[1] ?? options.name)
    if (!options.yes) fail('删除样式需要明确添加 --yes')
    const styleDir = join(TEMPLATES_DIR, name)
    if (!existsSync(styleDir)) fail(`未找到样式：${name}`)
    rmSync(styleDir, { recursive: true })
    const config = templateConfiguration()
    if (config.default_timeline_style === name) {
      config.default_timeline_style = 'default'
    }
    if (config.default_range_timeline_style === name) config.default_range_timeline_style = 'default'
    saveTemplateConfiguration(config)
    return printJson({ ok: true, deleted: name })
  }

  fail(`未知 style 操作：${action}`)
}

function queryDatabaseReports(dbPath, date) {
  const database = openDatabase(dbPath)
  try {
    const statement = date
      ? database.prepare(
          `SELECT id, type, period_date, generated_at, content, llm_model
           FROM reports WHERE type = 'daily' AND period_date = ? ORDER BY generated_at DESC`,
        )
      : database.prepare(
          `SELECT id, type, period_date, generated_at, content, llm_model
           FROM reports WHERE type = 'daily' ORDER BY generated_at DESC`,
        )
    return (date ? statement.all(date) : statement.all()).map((row) => ({
      ...row,
      id: Number(row.id),
      generated_at: Number(row.generated_at),
    }))
  } finally {
    database.close()
  }
}

async function listReports(options) {
  const date = options.date ? normalizeDate(options.date) : null
  if (!options.db) {
    const live = await requestRunningApp({ action: 'get_reports', report_type: 'daily', date })
    if (live?.reports) return live.reports
  }
  return queryDatabaseReports(options.db ? resolve(options.db) : DEFAULT_DB_PATH, date)
}

async function saveReport(options) {
  const date = normalizeDate(options.date)
  if (options.stdin && options.file) fail('--stdin 与 --file 不能同时使用')
  if (!options.stdin && !options.file) {
    fail('report save 需要 --stdin 或 --file <Markdown文件>')
  }
  const content = options.stdin
    ? readFileSync(0, 'utf8').trim()
    : readFileSync(resolve(options.file), 'utf8').trim()
  if (!content) fail('日报内容不能为空')
  if (content.length > 1_000_000) fail('日报内容不能超过 1 MB')
  const context = buildContext(await queryEvents(options))
  const eventIds = context.events.filter((event) => event.id > 0).map((event) => event.id)
  const generator = String(options.generator ?? 'agent').slice(0, 100)
  let id = null

  if (!options.db) {
    const live = await requestRunningApp({
      action: 'save_report',
      report_type: 'daily',
      date,
      content,
      event_ids: eventIds,
      llm_model: generator,
    }, 3000)
    if (live?.id) id = Number(live.id)
  }

  if (id === null) {
    const dbPath = options.db ? resolve(options.db) : DEFAULT_DB_PATH
    const database = openDatabase(dbPath, false)
    try {
      const result = database.prepare(
        `INSERT INTO reports (type, period_date, generated_at, content, event_ids, llm_model)
         VALUES ('daily', ?, ?, ?, ?, ?)`,
      ).run(
        date,
        Math.floor(Date.now() / 1000),
        content,
        JSON.stringify(eventIds),
        generator,
      )
      id = Number(result.lastInsertRowid)
    } finally {
      database.close()
    }
  }

  if (options['no-export']) return printJson({ ok: true, id, date, exported: false })
  const exportPath = outputPath(options, date, `daily-report-${id}.md`)
  writePrivateFile(exportPath, `${content}\n`)
  printJson({ ok: true, id, date, exported: true, path: exportPath })
}

async function reportContext(options) {
  const selection = resolveDateSelection(options)
  if (selection.kind === 'range') {
    return printCompactJson(await buildRangeReportContext(options, selection))
  }
  return printCompactJson(buildDayReportContext(await queryEvents(options)))
}

async function commandReport(positionals, options) {
  const action = positionals[0] ?? 'list'
  if (action === 'context') return reportContext(options)
  if (action === 'list') return printJson(await listReports(options))
  if (action === 'show') {
    const id = Number(positionals[1] ?? options.id)
    if (!Number.isInteger(id) || id <= 0) fail('report show 需要有效的日报 ID')
    const report = (await listReports(options)).find((item) => Number(item.id) === id)
    if (!report) fail(`未找到日报：${id}`)
    return printJson(report)
  }
  if (action === 'save') return saveReport(options)
  fail(`未知 report 操作：${action}`)
}

function printHelp() {
  process.stdout.write(`WorkDailyAgent CLI

用法：
  workdaily-agent doctor [--json]
  workdaily-agent setup
  workdaily-agent start
  workdaily-agent build
  workdaily-agent events [--date today | --from YYYY-MM-DD --to YYYY-MM-DD] [--db PATH] [--output DIR]
  workdaily-agent context [--date today | --from YYYY-MM-DD --to YYYY-MM-DD] [--detail summary|full] [--db PATH] [--output DIR]
  workdaily-agent timeline show [--date today | --from YYYY-MM-DD --to YYYY-MM-DD] [--style NAME | --template PATH] [--output PATH|DIR] [--expand-all | --collapse-all] [--no-open]
  workdaily-agent report context [--date today | --from YYYY-MM-DD --to YYYY-MM-DD] [--db PATH]
  workdaily-agent report list [--date YYYY-MM-DD]
  workdaily-agent report show ID
  workdaily-agent report save --date YYYY-MM-DD (--stdin | --file REPORT.md) [--no-export] [--generator agent]
  workdaily-agent style list
  workdaily-agent style save --name NAME --template TEMPLATE.html [--scope day|range] [--set-default]
  workdaily-agent style set-default NAME [--scope day|range]
  workdaily-agent style delete NAME --yes
`)
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const { options, positionals } = parseArgs(rest)
  if (options.help || command === 'help' || command === '--help') return printHelp()
  if (command === 'doctor') return commandDoctor(options)
  if (command === 'setup') return commandSetup()
  if (command === 'start') return commandStart(false)
  if (command === 'build') return commandStart(true)
  if (command === 'events') return commandEvents(options)
  if (command === 'context') return commandContext(options)
  if (command === 'timeline') return commandTimeline(positionals, options)
  if (command === 'report') return commandReport(positionals, options)
  if (command === 'style') return commandStyle(positionals, options)
  fail(`未知命令：${command}`)
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`)
  process.exitCode = error.exitCode ?? 1
})
