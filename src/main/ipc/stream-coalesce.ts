// Delta coalescing for the streaming IPC boundary (docs/streaming-render-alignment §3.1). CC's terminal
// renderer gates every paint through throttle(render, 16, {leading, trailing}); we apply the same
// semantics one layer down, at the main→renderer send: the first delta of a burst goes out immediately
// (leading edge — no latency on the first token), everything arriving inside the 16ms window merges into
// ONE trailing send, and an idle window stops the timer so the next burst leads again. A high-rate
// provider stream (100+ deltas/s) collapses to ≤60 IPC messages/s per lane without delaying anything
// the user could have seen sooner.
export class DeltaCoalescer {
  private buf = ''
  private timer: NodeJS.Timeout | null = null

  constructor(
    private flushFn: (text: string) => void,
    private interval = 16
  ) {}

  push(text: string): void {
    if (this.timer) {
      this.buf += text
      return
    }
    this.flushFn(text) // leading edge: the first delta of a burst goes out immediately
    this.timer = setTimeout(() => this.tick(), this.interval)
  }

  private tick(): void {
    if (this.buf) {
      const t = this.buf
      this.buf = ''
      this.flushFn(t)
      this.timer = setTimeout(() => this.tick(), this.interval)
    } else {
      this.timer = null // idle window → stop the clock; the next push leads again
    }
  }

  // Force the buffered tail out NOW and stop the clock. The ordering barrier: any structural event on
  // the same stream (tool card, step:start/done, permission, done/error) must be preceded by a flush so
  // text emitted BEFORE the event can never arrive at the renderer AFTER it. Also the terminal cleanup —
  // a flushed coalescer holds no timer, so nothing outlives the stream.
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buf) {
      const t = this.buf
      this.buf = ''
      this.flushFn(t)
    }
  }
}

// Per-stream coalescer set, keyed by lane. The coordinator wire interleaves several experts' text AND
// reasoning deltas on one streamId — different (roleId × channel) lanes must never merge into one
// payload, so each gets its own coalescer. flushAll() is the barrier a structural event calls before it
// is sent (cheap: lanes are few and a flushed lane is a no-op).
export class CoalescerGroup {
  private lanes = new Map<string, DeltaCoalescer>()

  constructor(private interval = 16) {}

  lane(key: string, flushFn: (text: string) => void): DeltaCoalescer {
    let c = this.lanes.get(key)
    if (!c) {
      c = new DeltaCoalescer(flushFn, this.interval)
      this.lanes.set(key, c)
    }
    return c
  }

  flushAll(): void {
    for (const c of this.lanes.values()) c.flush()
  }
}
