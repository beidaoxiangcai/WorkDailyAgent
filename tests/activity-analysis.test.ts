import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateUsage,
  buildActivityBlocks,
  formatPercentage,
  hasOverlappingEvents,
  splitIntoTimelineRanges,
  type ActivityEvent,
} from '../src/activity-analysis.ts'

function event(
  id: number,
  start: number,
  end: number,
  app: string,
  title: string | null,
  bundleId = `com.test.${app.toLowerCase()}`,
): ActivityEvent {
  return {
    id,
    start_ts: start,
    end_ts: end,
    app,
    bundle_id: bundleId,
    window_title: title,
    duration_ms: (end - start) * 1000,
    ongoing: false,
  }
}

test('相邻的同应用记录合并并保留标题分段', () => {
  const blocks = buildActivityBlocks([
    event(1, 100, 140, 'Xcode', 'AppDelegate.m'),
    event(2, 140, 180, 'Xcode', 'DataManager.swift'),
  ])

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].startTs, 100)
  assert.equal(blocks[0].endTs, 180)
  assert.deepEqual(
    blocks[0].titleSegments.map((segment) => segment.title),
    ['AppDelegate.m', 'DataManager.swift'],
  )
})

test('29 秒轨迹块被过滤，30 秒轨迹块保留', () => {
  const blocks = buildActivityBlocks([
    event(1, 100, 129, 'Short', 'short'),
    event(2, 200, 230, 'Boundary', 'boundary'),
  ])

  assert.deepEqual(blocks.map((block) => block.app), ['Boundary'])
})

test('被过滤事件前后的同应用记录不跨事件合并', () => {
  const blocks = buildActivityBlocks([
    event(1, 100, 160, 'Xcode', 'a'),
    event(2, 160, 180, 'ChatGPT', 'short'),
    event(3, 180, 240, 'Xcode', 'b'),
  ])

  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks.map((block) => [block.startTs, block.endTs]), [
    [100, 160],
    [180, 240],
  ])
})

test('跨 12 点轨迹先按完整时长保留，再拆分到两行', () => {
  const dayStart = 1_000_000
  const blocks = buildActivityBlocks([
    event(
      1,
      dayStart + 43_180,
      dayStart + 43_220,
      'Xcode',
      'cross-noon',
    ),
  ])
  const ranges = splitIntoTimelineRanges(blocks, dayStart)

  assert.equal(ranges[0].blocks.length, 1)
  assert.equal(ranges[1].blocks.length, 1)
  assert.equal(ranges[0].blocks[0].segmentEndTs - ranges[0].blocks[0].segmentStartTs, 20)
  assert.equal(ranges[1].blocks[0].segmentEndTs - ranges[1].blocks[0].segmentStartTs, 20)
})

test('应用占比使用未过滤数据并包含系统空闲', () => {
  const events = [
    event(1, 100, 120, 'Short', 'short'),
    event(2, 120, 180, 'Xcode', 'code'),
    event(3, 180, 220, '(空闲)', '系统空闲', ''),
    event(4, 80, 100, 'Xcode', 'earlier'),
  ]
  assert.equal(buildActivityBlocks(events).some((block) => block.app === 'Short'), false)

  const usage = aggregateUsage(events)
  assert.equal(usage.length, 3)
  assert.equal(usage.find((item) => item.app === 'Short')?.durationMs, 20_000)
  assert.equal(usage.find((item) => item.app === '系统空闲')?.durationMs, 40_000)
  assert.deepEqual(
    usage.find((item) => item.app === 'Xcode')?.details.map((detail) => ({
      title: detail.title,
      startTs: detail.startTs,
      endTs: detail.endTs,
    })),
    [
      { title: 'code', startTs: 120, endTs: 180 },
      { title: 'earlier', startTs: 80, endTs: 100 },
    ],
  )
  assert.ok(
    Math.abs(usage.reduce((sum, item) => sum + item.ratio, 0) - 1) <
      Number.EPSILON,
  )
})

test('百分比保留两位小数', () => {
  assert.equal(formatPercentage(0.123456), '12.35%')
  assert.equal(formatPercentage(1), '100.00%')
})

test('检测重叠事件', () => {
  assert.equal(
    hasOverlappingEvents([
      event(1, 100, 150, 'Xcode', 'a'),
      event(2, 140, 180, 'ChatGPT', 'b'),
    ]),
    true,
  )
  assert.equal(
    hasOverlappingEvents([
      event(1, 100, 150, 'Xcode', 'a'),
      event(2, 150, 180, 'ChatGPT', 'b'),
    ]),
    false,
  )
})
