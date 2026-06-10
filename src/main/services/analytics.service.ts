// Local-only analytics for the Overview › Stats page. Aggregates real data already on disk — no new
// tracking tables: token/activity numbers from `messages` (carries expert_id + model + in/out tokens),
// providers from `usage_events`, memory from `memories` + `memory_versions`, and the per-tool "tool calls
// today" by scanning the per-run transcripts (ts-stamped). All times are bucketed in the user's LOCAL day.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AnalyticsSummary, AppInfo } from '../ipc/contracts'
import * as analyticsRepo from '../repos/analytics.repo'
import * as convRepo from '../repos/conversation.repo'
import * as memoryRepo from '../repos/memory.repo'

// created_at is stored as UTC ISO (new Date().toISOString()); local-midnight N days ago as that same UTC ISO.
function localMidnightISO(daysAgo = 0): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}
function startOfTodayMs(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function lastDays(n: number): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    out.push(localDateKey(d))
  }
  return out
}

export function getSummary(): AnalyticsSummary {
  const today = localMidnightISO(0)
  const week = localMidnightISO(7)

  // Token usage from usage_events — the accurate per-run accounting (every turn's full context, what the
  // upstream actually billed), carrying expert_id + model + provider. messages would undercount (final reply
  // only) and lacks provider, so all token numbers come from one source here for a consistent scale.
  const tToday = analyticsRepo.tokensSince(today)
  const tAll = analyticsRepo.tokensAllTime()

  const byExpert = analyticsRepo.tokensByExpert()
  const byModel = analyticsRepo.tokensByModel()
  const byProvider = analyticsRepo.tokensByProvider()

  const dayMap = new Map(analyticsRepo.tokensByLocalDay(localMidnightISO(6)).map((r) => [r.d, r.v]))
  const byDay = lastDays(7).map((d) => ({ d: d.slice(5), v: dayMap.get(d) ?? 0 }))

  const convTotal = convRepo.count()

  const actMap = new Map(analyticsRepo.messagesByLocalDay(localMidnightISO(13)).map((r) => [r.d, r.v]))
  const actByDay = lastDays(14).map((d) => actMap.get(d) ?? 0)

  const todayByExpert = analyticsRepo.expertMessageCountsSince(today)
  const weekByExpert = new Map(analyticsRepo.expertMessageCountsSince(week).map((r) => [r.id, r.v]))
  const top = todayByExpert[0]
  const mostActive = top ? { id: top.id, today: top.v, week: weekByExpert.get(top.id) ?? top.v } : { id: '', today: 0, week: 0 }

  const hourRows = analyticsRepo.messagesByLocalHour(today)
  const peakHours = Array.from({ length: 24 }, (_, h) => hourRows.find((r) => r.h === h)?.v ?? 0)

  const memTotal = memoryRepo.count()
  const perExpert = analyticsRepo.memoriesPerRole()
  const layerMap = new Map(analyticsRepo.memoriesByLayer().map((r) => [r.layer, r.v]))
  const layers = [
    { key: 'Shared', hint: 'about you', v: layerMap.get('shared') ?? 0 },
    { key: 'Role', hint: 'per expert', v: layerMap.get('role') ?? 0 },
    { key: 'Collab', hint: 'project', v: layerMap.get('collab') ?? 0 }
  ]
  const approved = analyticsRepo.learningCount()
  const corrected = analyticsRepo.correctionCount()
  const byWeek = [0, 0, 0, 0]
  const nowMs = Date.now()
  for (const createdAt of analyticsRepo.learningCreatedSince(localMidnightISO(27))) {
    const wk = Math.min(3, Math.max(0, Math.floor((nowMs - new Date(createdAt).getTime()) / (7 * 86_400_000))))
    byWeek[3 - wk]++ // index 0 = oldest week, 3 = current
  }

  return {
    usage: {
      tokensToday: tToday.i + tToday.o,
      tokensAllTime: tAll,
      tokensIn: tToday.i,
      tokensOut: tToday.o,
      byDay,
      conversationsTotal: convTotal,
      byExpert,
      byModel: byModel.map((r) => ({ label: r.model, v: r.v })),
      byProvider: byProvider.map((r) => ({ label: r.provider, v: r.v }))
    },
    memory: { total: memTotal, perExpert, layers, learning: { approved, corrected, byWeek } },
    activity: { byDay: actByDay, mostActive, tools: scanToolsToday(), peakHours }
  }
}

// "Tool calls today" by tool name. The transcript jsonl stamps each event with `ts`; we only scan
// transcripts touched today (mtime gate) and only count tool_use blocks whose line ts is in today.
function scanToolsToday(): { label: string; v: number }[] {
  const dir = join(homedir(), '.nsai', 'sessions')
  const todayMs = startOfTodayMs()
  const counts = new Map<string, number>()
  let sessions: string[]
  try {
    sessions = readdirSync(dir)
  } catch {
    return []
  }
  for (const s of sessions) {
    const f = join(dir, s, 'transcript.jsonl')
    try {
      if (statSync(f).mtimeMs < todayMs) continue
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        if (!line) continue
        let o: { t?: string; ts?: number; event?: { type?: string; message?: { content?: { type?: string; name?: string }[] } } }
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        if (o.t !== 'event' || typeof o.ts !== 'number' || o.ts < todayMs) continue
        if (o.event?.type !== 'assistant') continue
        for (const b of o.event.message?.content ?? []) {
          if (b.type === 'tool_use' && b.name) counts.set(b.name, (counts.get(b.name) ?? 0) + 1)
        }
      }
    } catch {
      /* unreadable transcript — skip */
    }
  }
  return [...counts.entries()].map(([label, v]) => ({ label, v })).sort((a, b) => b.v - a.v)
}

// Settings › About / Privacy: app version + local data dir + on-device counts. Version is injected at
// build time (see media.handler / electron.vite.config.ts) and passed in by the boundary; the counts go
// through the repos so this service adds no new inline SQL.
export function appInfo(version: string): AppInfo {
  return {
    version,
    dataDir: join(homedir(), '.nsai'),
    conversations: convRepo.count(),
    memories: memoryRepo.count()
  }
}
