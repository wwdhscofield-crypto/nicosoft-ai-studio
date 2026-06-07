// Cron + interval parsing for scheduled tasks (batch 1 / doc 28). Zero-dependency 5-field cron
// (M H DoM Mon DoW, LOCAL time) — the standard cron shape. Supports *, ranges (1-5), steps (*/5), lists
// (1,3,5). Plus a /loop-style interval shorthand (5m → */5 * * * *) and one-shot ISO datetimes. The
// scheduler engine (batch 2) only ever reads nextRunAt; this module computes it.

export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number> // 0 = Sunday
}

// Parse one field into the set of matching values in [min, max]. null on malformed input.
function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    let step = 1
    let range = part
    const slash = part.indexOf('/')
    if (slash >= 0) {
      step = Number(part.slice(slash + 1))
      range = part.slice(0, slash)
      if (!Number.isInteger(step) || step < 1) return null
    }
    let lo = min
    let hi = max
    if (range !== '*') {
      const dash = range.indexOf('-')
      if (dash >= 0) {
        lo = Number(range.slice(0, dash))
        hi = Number(range.slice(dash + 1))
      } else {
        lo = hi = Number(range)
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size ? out : null
}

export function parseCron(cron: string): CronFields | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = parseField(parts[0], 0, 59)
  const hour = parseField(parts[1], 0, 23)
  const dom = parseField(parts[2], 1, 31)
  const month = parseField(parts[3], 1, 12)
  const dow = parseField(parts[4], 0, 6)
  if (!minute || !hour || !dom || !month || !dow) return null
  return { minute, hour, dom, month, dow }
}

function matches(f: CronFields, d: Date): boolean {
  // Standard cron DoM/DoW: if both restricted, match EITHER; if one is '*', use the other. (size === full
  // range means unrestricted.)
  const domStar = f.dom.size === 31
  const dowStar = f.dow.size === 7
  const domOk = f.dom.has(d.getDate())
  const dowOk = f.dow.has(d.getDay())
  const dayOk = domStar && dowStar ? true : domStar ? dowOk : dowStar ? domOk : domOk || dowOk
  return f.minute.has(d.getMinutes()) && f.hour.has(d.getHours()) && f.month.has(d.getMonth() + 1) && dayOk
}

// Next epoch-ms the cron fires strictly after fromMs. Scans minute-by-minute up to ~366 days; null if
// nothing matches in that window (e.g. an impossible Feb 30).
export function nextCronRun(cron: string, fromMs: number): number | null {
  const f = parseCron(cron)
  if (!f) return null
  const d = new Date(fromMs)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1) // strictly after
  const limit = fromMs + 366 * 24 * 60 * 60 * 1000
  while (d.getTime() <= limit) {
    if (matches(f, d)) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  return null
}

// /loop-style interval shorthand → cron. 5m → */5 * * * *, 2h → 0 */2 * * *, 1d → 0 0 */1 * *. null if the
// token isn't an interval (or out of cron's representable range).
export function intervalToCron(token: string): string | null {
  const m = /^(\d+)([mhd])$/.exec(token.trim())
  if (!m) return null
  const n = Number(m[1])
  if (n < 1) return null
  switch (m[2]) {
    case 'm':
      return n < 60 ? `*/${n} * * * *` : null
    case 'h':
      return n < 24 ? `0 */${n} * * *` : null
    case 'd':
      return `0 0 */${n} * *`
    default:
      return null
  }
}

export interface ParsedSchedule {
  cron: string | null // recurring cron expr; null for a one-shot
  nextRunAt: number // epoch ms of the first fire
  recurring: boolean
}

// Interpret a user-facing schedule string, anchored at nowMs:
//   • interval shorthand: "5m" / "2h" / "1d"        → recurring
//   • one-shot ISO datetime: "2026-06-05T15:00"     → fires once (local time)
//   • 5-field cron: "0 9 * * 1-5"                    → recurring
// Returns null if none parse or the time is already in the past.
export function parseSchedule(input: string, nowMs: number): ParsedSchedule | null {
  const s = input.trim()
  const iv = intervalToCron(s)
  if (iv) {
    const next = nextCronRun(iv, nowMs)
    return next ? { cron: iv, nextRunAt: next, recurring: true } : null
  }
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/.test(s)) {
    const ms = Date.parse(s)
    return Number.isFinite(ms) && ms > nowMs ? { cron: null, nextRunAt: ms, recurring: false } : null
  }
  if (parseCron(s)) {
    const next = nextCronRun(s, nowMs)
    return next ? { cron: s, nextRunAt: next, recurring: true } : null
  }
  return null
}
