// Read-only aggregation queries behind the Overview › Stats page (analytics.service shapes the results).
// Pure SQL over usage_events / messages / memories / memory_versions — no business shaping here.
// `sinceISO` params are UTC ISO strings; the 'localtime' modifiers bucket into the user's local day/hour.

import { getDb } from '../db/connection'

export function tokensSince(sinceISO: string): { i: number; o: number } {
  return getDb()
    .prepare('SELECT COALESCE(SUM(in_tokens),0) i, COALESCE(SUM(out_tokens),0) o FROM usage_events WHERE created_at >= ?')
    .get(sinceISO) as { i: number; o: number }
}

export function tokensAllTime(): number {
  return (getDb().prepare('SELECT COALESCE(SUM(in_tokens + out_tokens),0) v FROM usage_events').get() as { v: number }).v
}

export function tokensByExpert(): { id: string; v: number }[] {
  return getDb()
    .prepare('SELECT expert_id id, SUM(in_tokens + out_tokens) v FROM usage_events WHERE expert_id IS NOT NULL GROUP BY expert_id ORDER BY v DESC')
    .all() as { id: string; v: number }[]
}

export function tokensByModel(): { model: string; v: number }[] {
  return getDb()
    .prepare("SELECT model, SUM(in_tokens + out_tokens) v FROM usage_events WHERE model IS NOT NULL AND model != '' GROUP BY model ORDER BY v DESC")
    .all() as { model: string; v: number }[]
}

export function tokensByProvider(): { provider: string; v: number }[] {
  return getDb()
    .prepare("SELECT provider, SUM(in_tokens + out_tokens) v FROM usage_events WHERE provider IS NOT NULL AND provider != '' GROUP BY provider ORDER BY v DESC")
    .all() as { provider: string; v: number }[]
}

export function tokensByLocalDay(sinceISO: string): { d: string; v: number }[] {
  return getDb()
    .prepare("SELECT date(created_at, 'localtime') d, SUM(in_tokens + out_tokens) v FROM usage_events WHERE created_at >= ? GROUP BY d")
    .all(sinceISO) as { d: string; v: number }[]
}

export function messagesByLocalDay(sinceISO: string): { d: string; v: number }[] {
  return getDb()
    .prepare("SELECT date(created_at, 'localtime') d, COUNT(*) v FROM messages WHERE created_at >= ? GROUP BY d")
    .all(sinceISO) as { d: string; v: number }[]
}

export function expertMessageCountsSince(sinceISO: string): { id: string; v: number }[] {
  return getDb()
    .prepare("SELECT expert_id id, COUNT(*) v FROM messages WHERE author='expert' AND expert_id IS NOT NULL AND created_at >= ? GROUP BY expert_id ORDER BY v DESC")
    .all(sinceISO) as { id: string; v: number }[]
}

export function messagesByLocalHour(sinceISO: string): { h: number; v: number }[] {
  return getDb()
    .prepare("SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) h, COUNT(*) v FROM messages WHERE created_at >= ? GROUP BY h")
    .all(sinceISO) as { h: number; v: number }[]
}

export function memoriesPerRole(): { id: string; v: number }[] {
  return getDb()
    .prepare('SELECT role_id id, COUNT(*) v FROM memories WHERE role_id IS NOT NULL GROUP BY role_id ORDER BY v DESC')
    .all() as { id: string; v: number }[]
}

export function memoriesByLayer(): { layer: string; v: number }[] {
  return getDb().prepare('SELECT layer, COUNT(*) v FROM memories GROUP BY layer').all() as { layer: string; v: number }[]
}

export function learningCount(): number {
  return (getDb().prepare("SELECT COUNT(*) c FROM memories WHERE type='learning'").get() as { c: number }).c
}

export function correctionCount(): number {
  return (getDb().prepare('SELECT COUNT(*) c FROM memory_versions').get() as { c: number }).c
}

export function learningCreatedSince(sinceISO: string): string[] {
  return (
    getDb().prepare("SELECT created_at FROM memories WHERE type='learning' AND created_at >= ?").all(sinceISO) as {
      created_at: string
    }[]
  ).map((r) => r.created_at)
}
