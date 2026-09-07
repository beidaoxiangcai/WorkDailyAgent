import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const cliPath = resolve('skills/work-daily-agent/scripts/workdaily-agent.mjs')
const skillPath = resolve('skills/work-daily-agent/SKILL.md')

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workdaily-cli-'))
  const dbPath = join(directory, 'workdaily.db')
  const database = new DatabaseSync(dbPath)
  database.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      app TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      window_title TEXT,
      duration_ms INTEGER NOT NULL,
      category TEXT,
      source TEXT NOT NULL DEFAULT 'system',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      period_date TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      content TEXT NOT NULL,
      event_ids TEXT,
      llm_model TEXT
    );
  `)
  const insert = database.prepare(`
    INSERT INTO events
      (start_ts, end_ts, app, bundle_id, window_title, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const dayStart = Date.parse('2026-09-07T00:00:00+08:00') / 1000
  insert.run(
    dayStart + 9 * 3600,
    dayStart + 10 * 3600,
    'Xcode',
    'com.apple.dt.Xcode',
    'WorkDailyAgent — AppDelegate.m',
    3_600_000,
    dayStart,
  )
  insert.run(
    dayStart + 9.5 * 3600,
    dayStart + 10.5 * 3600,
    '(空闲)',
    '',
    '系统空闲',
    3_600_000,
    dayStart,
  )
  insert.run(
    dayStart + 11 * 3600,
    dayStart + 11 * 3600 + 10,
    'Finder',
    'com.apple.finder',
    '<script>alert(1)</script>',
    10_000,
    dayStart,
  )
  database.close()
  return { directory, dbPath }
}

function runCli(args, environment) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  })
}

function insertEvent(dbPath, start, end, app, bundleId, title) {
  const database = new DatabaseSync(dbPath)
  database.prepare(`
    INSERT INTO events
      (start_ts, end_ts, app, bundle_id, window_title, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(start, end, app, bundleId, title, (end - start) * 1000, start)
  database.close()
}

test('context normalizes idle overlap and keeps short events out of activity blocks', () => {
  const { directory, dbPath } = fixture()
  try {
    const output = runCli(
      ['context', '--date', '2026-09-07', '--db', dbPath],
      { WORKDAILY_APP_DATA_DIR: directory },
    )
    const context = JSON.parse(output)
    assert.equal(context.live, false)
    assert.equal(context.source, 'sqlite')
    assert.equal(context.events.length, 3)
    assert.equal(context.activity_blocks.length, 2)
    const idle = context.events.find((event) => event.app === '(空闲)')
    assert.equal(idle.start_ts, Date.parse('2026-09-07T10:00:00+08:00') / 1000)
    assert.equal(idle.duration_ms, 30 * 60 * 1000)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('timeline renderer creates a self-contained escaped HTML snapshot', () => {
  const { directory, dbPath } = fixture()
  try {
    const outputPath = join(directory, 'timeline.html')
    const output = runCli(
      [
        'timeline',
        'show',
        '--date',
        '2026-09-07',
        '--db',
        dbPath,
        '--output',
        outputPath,
        '--no-open',
        '--json',
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    )
    const result = JSON.parse(output)
    assert.equal(result.path, outputPath)
    assert.ok(existsSync(outputPath))
    const html = readFileSync(outputPath, 'utf8')
    assert.ok(html.includes('2026-09-07'))
    assert.ok(!html.includes('{{WORKDAILY_DATA_JSON}}'))
    assert.ok(!html.includes('<script>alert(1)</script>'))
    assert.ok(html.includes('\\u003cscript>alert(1)\\u003c/script>'))

    const database = new DatabaseSync(dbPath, { readOnly: true })
    const reportCount = database.prepare('SELECT COUNT(*) AS count FROM reports').get()
    database.close()
    assert.equal(Number(reportCount.count), 0)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('saved timeline styles can become the reusable default', () => {
  const { directory, dbPath } = fixture()
  try {
    const templatePath = join(directory, 'compact.html')
    writeFileSync(
      templatePath,
      '<!doctype html><title>Compact</title><main>reusable-style</main>' +
        '<script type="application/json">{{WORKDAILY_DATA_JSON}}</script>',
    )
    runCli(
      ['style', 'save', '--name', 'compact', '--template', templatePath, '--set-default'],
      { WORKDAILY_APP_DATA_DIR: directory },
    )

    const styles = JSON.parse(
      runCli(['style', 'list'], { WORKDAILY_APP_DATA_DIR: directory }),
    )
    assert.equal(styles.find((style) => style.name === 'compact').is_default, true)

    const outputPath = join(directory, 'reused.html')
    runCli(
      [
        'timeline',
        'show',
        '--date',
        '2026-09-07',
        '--db',
        dbPath,
        '--output',
        outputPath,
        '--no-open',
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    )
    const html = readFileSync(outputPath, 'utf8')
    assert.ok(html.includes('reusable-style'))
    assert.ok(html.includes('2026-09-07'))
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('report save writes the existing reports table and an export file', () => {
  const { directory, dbPath } = fixture()
  try {
    const reportPath = join(directory, 'draft.md')
    writeFileSync(reportPath, '【今日完成】\n- 完成 CLI 数据查询验证。\n')
    const output = runCli(
      [
        'report',
        'save',
        '--date',
        '2026-09-07',
        '--file',
        reportPath,
        '--db',
        dbPath,
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    )
    const result = JSON.parse(output)
    assert.equal(result.id, 1)
    assert.ok(existsSync(result.path))

    const database = new DatabaseSync(dbPath, { readOnly: true })
    const row = database.prepare('SELECT content, llm_model FROM reports WHERE id = 1').get()
    database.close()
    assert.equal(row.llm_model, 'agent')
    assert.ok(row.content.includes('CLI 数据查询验证'))
    assert.equal(existsSync(join(directory, 'exports', '2026-09-07', 'behavior-timeline.html')), false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('range context includes both endpoints and preserves empty days', () => {
  const { directory, dbPath } = fixture()
  try {
    const context = JSON.parse(runCli(
      ['context', '--from', '2026-09-01', '--to', '2026-09-10', '--db', dbPath],
      { WORKDAILY_APP_DATA_DIR: directory },
    ))
    assert.equal(context.kind, 'range')
    assert.equal(context.from, '2026-09-01')
    assert.equal(context.to, '2026-09-10')
    assert.equal(context.chunk_days, 7)
    assert.equal(context.chunk_count, 2)
    assert.equal(context.days.length, 10)
    assert.equal(context.days[0].date, '2026-09-01')
    assert.equal(context.days.at(-1).date, '2026-09-10')
    assert.equal(context.days[0].totals.event_count, 0)
    assert.ok(context.days.find((day) => day.date === '2026-09-07').totals.event_count > 0)
    assert.equal('events' in context.days.find((day) => day.date === '2026-09-07'), false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('range query clips cross-midnight events without duplicating duration', () => {
  const { directory, dbPath } = fixture()
  try {
    const start = Date.parse('2026-09-07T23:30:00+08:00') / 1000
    const end = Date.parse('2026-09-08T00:30:00+08:00') / 1000
    insertEvent(dbPath, start, end, 'Terminal', 'com.apple.Terminal', 'range-boundary')
    const context = JSON.parse(runCli(
      ['context', '--from', '2026-09-01', '--to', '2026-09-10', '--db', dbPath],
      { WORKDAILY_APP_DATA_DIR: directory },
    ))
    const terminal = context.usage.find((item) => item.key === 'com.apple.Terminal')
    assert.equal(terminal.duration_ms, 60 * 60 * 1000)
    assert.equal(context.days.find((day) => day.date === '2026-09-07').usage
      .find((item) => item.key === 'com.apple.Terminal').duration_ms, 30 * 60 * 1000)
    assert.equal(context.days.find((day) => day.date === '2026-09-08').usage
      .find((item) => item.key === 'com.apple.Terminal').duration_ms, 30 * 60 * 1000)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('ten-day timeline uses two database chunks but writes one range entry', () => {
  const { directory, dbPath } = fixture()
  try {
    const outputDirectory = join(
      directory,
      'exports',
      '2026-08-30-to-2026-09-08',
      'behavior-timeline',
    )
    const result = JSON.parse(runCli(
      [
        'timeline',
        'show',
        '--from',
        '2026-08-30',
        '--to',
        '2026-09-08',
        '--db',
        dbPath,
        '--no-open',
        '--json',
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    ))
    assert.equal(result.initial_expansion, 'none')
    assert.equal(result.days, 10)
    assert.equal(result.chunk_count, 2)
    assert.equal(result.directory, outputDirectory)
    assert.equal(result.path, join(outputDirectory, 'index.html'))
    assert.deepEqual(
      readdirSync(outputDirectory).filter((name) => name.endsWith('.html')),
      ['index.html'],
    )
    assert.ok(existsSync(join(outputDirectory, 'assets', 'renderer.js')))
    assert.deepEqual(readdirSync(join(outputDirectory, 'data')).toSorted(), [
      '2026-08-30.js',
      '2026-08-31.js',
      '2026-09-01.js',
      '2026-09-02.js',
      '2026-09-03.js',
      '2026-09-04.js',
      '2026-09-05.js',
      '2026-09-06.js',
      '2026-09-07.js',
      '2026-09-08.js',
    ])
    assert.equal(
      existsSync(join(directory, 'exports', '2026-08-30-to-2026-09-05')),
      false,
    )
    assert.equal(
      existsSync(join(directory, 'exports', '2026-09-06-to-2026-09-08')),
      false,
    )
    assert.equal(statSync(join(outputDirectory, 'data')).mode & 0o777, 0o700)
    assert.equal(statSync(join(outputDirectory, 'data', '2026-09-07.js')).mode & 0o777, 0o600)

    const index = readFileSync(result.path, 'utf8')
    assert.ok(index.includes('"initial_expansion":"none"'))
    assert.ok(index.includes('assets/renderer.js'))
    assert.ok(!index.includes('<script>alert(1)</script>'))
    const dayScript = readFileSync(join(outputDirectory, 'data', '2026-09-07.js'), 'utf8')
    assert.ok(dayScript.startsWith('window.WorkDailyRangeData.register("2026-09-07"'))
    assert.ok(dayScript.includes('\\u003cscript>alert(1)\\u003c/script>'))
    assert.ok(!dayScript.includes('<script>alert(1)</script>'))

    const database = new DatabaseSync(dbPath, { readOnly: true })
    const reportCount = database.prepare('SELECT COUNT(*) AS count FROM reports').get()
    database.close()
    assert.equal(Number(reportCount.count), 0)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('skill keeps a complete timeline range in one CLI invocation', () => {
  const skill = readFileSync(skillPath, 'utf8')
  assert.match(skill, /完整日期范围传给一次 `timeline show --from/)
  assert.match(skill, /7 天仅是 CLI 内部的 SQLite 查询分批大小/)
  assert.match(skill, /不得因范围超过 7 天而拆成多次 `timeline show`/)
  assert.doesNotMatch(skill, /多日轨迹每次最多查询 7 个自然日/)
})

test('seven-day timeline expands by default and supports explicit collapse override', () => {
  const { directory, dbPath } = fixture()
  try {
    const expanded = JSON.parse(runCli(
      [
        'timeline', 'show', '--from', '2026-09-01', '--to', '2026-09-07',
        '--db', dbPath, '--output', join(directory, 'expanded'), '--no-open', '--json',
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    ))
    assert.equal(expanded.initial_expansion, 'all')

    const collapsed = JSON.parse(runCli(
      [
        'timeline', 'show', '--from', '2026-09-01', '--to', '2026-09-07',
        '--db', dbPath, '--output', join(directory, 'collapsed'), '--collapse-all',
        '--no-open', '--json',
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    ))
    assert.equal(collapsed.initial_expansion, 'none')
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('saved range style can be reused independently from the day default', () => {
  const { directory, dbPath } = fixture()
  try {
    const templatePath = join(directory, 'range-template.html')
    writeFileSync(
      templatePath,
      '<!doctype html><main id="range-days">range-custom-style</main>' +
        '<script id="workdaily-range-data" type="application/json">' +
        '{{WORKDAILY_RANGE_JSON}}</script><script src="assets/renderer.js"></script>',
    )
    runCli(
      [
        'style', 'save', '--name', 'range-compact', '--template', templatePath,
        '--scope', 'range', '--set-default',
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    )
    const outputDirectory = join(directory, 'custom-range')
    runCli(
      [
        'timeline', 'show', '--from', '2026-09-06', '--to', '2026-09-07',
        '--db', dbPath, '--output', outputDirectory, '--no-open',
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    )
    assert.ok(readFileSync(join(outputDirectory, 'index.html'), 'utf8').includes('range-custom-style'))
    const config = JSON.parse(readFileSync(join(directory, 'templates', 'config.json'), 'utf8'))
    assert.equal(config.default_range_timeline_style, 'range-compact')
    assert.equal(config.default_timeline_style, 'default')
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('range parameters reject partial, reversed, and mixed date selections', () => {
  const { directory, dbPath } = fixture()
  try {
    assert.throws(() => runCli(
      ['context', '--from', '2026-09-01', '--db', dbPath],
      { WORKDAILY_APP_DATA_DIR: directory },
    ), /--from 和 --to/)
    assert.throws(() => runCli(
      ['context', '--from', '2026-09-10', '--to', '2026-09-01', '--db', dbPath],
      { WORKDAILY_APP_DATA_DIR: directory },
    ), /开始日期不能晚于结束日期/)
    assert.throws(() => runCli(
      [
        'context', '--date', '2026-09-07', '--from', '2026-09-01',
        '--to', '2026-09-10', '--db', dbPath,
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    ), /--date 不能与 --from\/--to/)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('range events and full context write private per-day JSON files', () => {
  const { directory, dbPath } = fixture()
  try {
    const eventsDirectory = join(directory, 'range-events')
    const events = JSON.parse(runCli(
      [
        'events', '--from', '2026-09-06', '--to', '2026-09-08', '--db', dbPath,
        '--output', eventsDirectory,
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    ))
    assert.ok(existsSync(events.path))
    assert.ok(existsSync(join(eventsDirectory, 'days', '2026-09-06.json')))
    const eventManifest = JSON.parse(readFileSync(events.path, 'utf8'))
    assert.equal(eventManifest.days[0].data_path, 'days/2026-09-06.json')

    const contextDirectory = join(directory, 'range-context')
    const context = JSON.parse(runCli(
      [
        'context', '--from', '2026-09-06', '--to', '2026-09-08', '--detail', 'full',
        '--db', dbPath, '--output', contextDirectory,
      ],
      { WORKDAILY_APP_DATA_DIR: directory },
    ))
    assert.equal(context.detail, 'full')
    const dayContext = JSON.parse(
      readFileSync(join(contextDirectory, 'days', '2026-09-07.json'), 'utf8'),
    )
    assert.ok(Array.isArray(dayContext.events))
    assert.ok(Array.isArray(dayContext.activity_blocks))
  } finally {
    rmSync(directory, { recursive: true })
  }
})
