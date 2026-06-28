// self-rhythm.service.ts — the model's own pacing. Where the scheduler fires on a cron/clock the user set, this
// lets the AGENT decide WHEN to wake itself next: it picks a delay, and at that delay its given prompt is
// injected back into THIS conversation via the unified session bus — the same wakeup primitive Monitor / hooks
// use. delaySeconds is clamped at the runtime to [60, 3600] (the verified bound). While a wakeup is pending the
// session is kept alive (a collaboration won't quiesce out from under a self-scheduled wake; a solo conv stays
// resumable), released when it fires or is cancelled.

import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from 'node:timers'
import { ulid } from '../db/id'
import { sessionBus } from '../agent/session-bus'

const MIN_DELAY_S = 60
const MAX_DELAY_S = 3600

interface Wakeup {
  id: string
  convId: string
  timer: ReturnType<typeof nodeSetTimeout>
}

class SelfRhythmService {
  private wakeups = new Map<string, Wakeup>()

  // Arm a self-wakeup: fire `prompt` back into `convId` after the (clamped) delay. Returns the id + actual delay.
  schedule(convId: string, prompt: string, delaySeconds: number, roleId?: string): { id: string; delaySeconds: number } {
    const clamped = Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(delaySeconds)))
    const id = ulid()
    sessionBus.addKeepalive(convId, `wakeup:${id}`) // hold the session open until the wake fires
    const timer = nodeSetTimeout(() => {
      this.wakeups.delete(id)
      sessionBus.inject(convId, { text: prompt, source: `self-rhythm:${id}`, priority: 'later', roleId })
      sessionBus.removeKeepalive(convId, `wakeup:${id}`)
    }, clamped * 1000)
    this.wakeups.set(id, { id, convId, timer })
    console.log(`[self-rhythm] scheduled wakeup id=${id} conv=${convId} in=${clamped}s`)
    return { id, delaySeconds: clamped }
  }

  cancel(id: string): boolean {
    const w = this.wakeups.get(id)
    if (!w) return false
    nodeClearTimeout(w.timer)
    this.wakeups.delete(id)
    sessionBus.removeKeepalive(w.convId, `wakeup:${id}`)
    return true
  }

  disposeForConv(convId: string): void {
    for (const w of [...this.wakeups.values()]) if (w.convId === convId) this.cancel(w.id)
  }

  disposeAll(): void {
    for (const w of [...this.wakeups.values()]) this.cancel(w.id)
  }
}

export const selfRhythmService = new SelfRhythmService()
