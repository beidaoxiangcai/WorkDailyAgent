import { localDayStartTs, type ActivityEvent } from './activity-analysis'

interface DemoEvent {
  start: string
  end: string
  app: string
  bundleId: string
  title: string | null
}

const DEMO_EVENTS: DemoEvent[] = [
  { start: '07:45:00', end: '08:35:00', app: 'ChatGPT', bundleId: 'com.openai.chat', title: 'ChatGPT' },
  { start: '08:40:00', end: '09:05:00', app: '微信', bundleId: 'com.tencent.xinWeChat', title: '微信' },
  { start: '09:05:00', end: '09:12:00', app: 'Sourcetree', bundleId: 'com.torusknot.SourceTreeNotMAS', title: 'dailyWorkCollector (Git)' },
  { start: '09:12:00', end: '09:45:00', app: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'storage.rs' },
  { start: '09:45:00', end: '10:26:00', app: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'AppDelegate.m' },
  { start: '10:28:00', end: '10:33:00', app: '微信', bundleId: 'com.tencent.xinWeChat', title: '微信' },
  { start: '10:35:00', end: '11:00:00', app: 'ChatGPT', bundleId: 'com.openai.chat', title: 'ChatGPT' },
  { start: '11:00:00', end: '12:20:00', app: '(空闲)', bundleId: '', title: '系统空闲' },
  { start: '12:20:00', end: '12:28:00', app: 'Sourcetree', bundleId: 'com.torusknot.SourceTreeNotMAS', title: 'dailyWorkCollector (Git)' },
  { start: '12:30:00', end: '13:05:00', app: 'ChatGPT', bundleId: 'com.openai.chat', title: 'ChatGPT' },
  { start: '13:25:00', end: '14:10:00', app: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'ViewController.m' },
  { start: '14:10:00', end: '15:10:00', app: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'DataManager.swift' },
  { start: '15:10:00', end: '15:58:00', app: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'Networking.swift' },
  { start: '15:59:00', end: '16:25:00', app: '微信', bundleId: 'com.tencent.xinWeChat', title: '微信' },
  { start: '16:30:00', end: '16:35:00', app: 'Code', bundleId: 'com.microsoft.VSCode', title: 'activity-analysis.ts' },
  { start: '16:35:00', end: '16:40:00', app: 'Code', bundleId: 'com.microsoft.VSCode', title: 'ActivityAnalysisPage.tsx' },
  { start: '17:34:00', end: '17:34:20', app: 'ChatGPT', bundleId: 'com.openai.chat', title: '20s hidden event' },
  { start: '17:35:00', end: '17:43:00', app: 'Sourcetree', bundleId: 'com.torusknot.SourceTreeNotMAS', title: 'dailyWorkCollector (Git)' },
  { start: '17:43:00', end: '18:11:00', app: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'Utils.swift' },
  { start: '18:11:00', end: '18:36:00', app: '(空闲)', bundleId: '', title: '系统空闲' },
  { start: '18:36:00', end: '20:22:00', app: 'ChatGPT', bundleId: 'com.openai.chat', title: 'ChatGPT' },
  { start: '20:22:00', end: '21:12:00', app: '(空闲)', bundleId: '', title: '系统空闲' },
  { start: '21:22:00', end: '21:44:00', app: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'Tests.swift' },
]

function secondsSinceMidnight(time: string): number {
  const [hours, minutes, seconds] = time.split(':').map(Number)
  return hours * 3600 + minutes * 60 + seconds
}

export function buildActivityDemoEvents(date: string): ActivityEvent[] {
  const dayStart = localDayStartTs(date)
  return DEMO_EVENTS.map((event, index) => {
    const startTs = dayStart + secondsSinceMidnight(event.start)
    const endTs = dayStart + secondsSinceMidnight(event.end)
    return {
      id: index + 1,
      start_ts: startTs,
      end_ts: endTs,
      app: event.app,
      bundle_id: event.bundleId,
      window_title: event.title,
      duration_ms: (endTs - startTs) * 1000,
      ongoing: false,
    }
  })
}
