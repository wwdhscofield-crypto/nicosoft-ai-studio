/* ============================================================
   NicoSoft AI Studio — Studio › Stats (local-only analytics)
   Restrained charts: thin lines, low-sat bars, hairline gridlines.
   No gradients / 3D / glow. No cost-billing. No reliability panel.
   ============================================================ */
import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Icons, toolIconName } from '@/components/icons'
import { Avatar } from '@/components/primitives'
import { STUDIO_DATA, expertMeta } from '@/data/studio-data'
import { fmtTokens } from '@/lib/format'
import { useChat } from '@/stores/chat'
import type { AnalyticsSummary } from '@/lib/api'

const FAMILY_COLOR: Record<string, string> = {
  anthropic: "oklch(0.76 0.10 50)",
  openai: "oklch(0.75 0.10 158)",
  gemini: "oklch(0.74 0.10 250)",
};

// Verification-gate outcome colors (same restrained oklch family as FAMILY_COLOR): verified-good in
// green, recovered (fixed after a FAIL) in amber, a misjudging verifier in neutral, unresolved in red,
// unverified (infra) in dim.
const GATE_COLOR: Record<string, string> = {
  pass: "oklch(0.75 0.10 158)",
  fixed: "oklch(0.76 0.10 50)",
  "false-positive": "var(--text-3)",
  unresolved: "oklch(0.68 0.12 25)",
  unverified: "var(--text-4)",
  PASS: "oklch(0.75 0.10 158)",
  FAIL: "oklch(0.68 0.12 25)",
  BLOCKED: "oklch(0.76 0.10 50)",
  SKIP: "var(--text-4)",
};

// model slug → provider family, for the by-model bar colors (messages/usage_events store the slug).
function providerOf(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('claude')) return 'anthropic'
  if (m.includes('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.includes('openai')) return 'openai'
  if (m.includes('gemini') || m.includes('imagen') || m.includes('nano-banana')) return 'gemini'
  return 'other'
}

type TrendPoint = number | { v: number }

/* — Thin line trend with hairline gridlines (non-scaling strokes) — */
function LineTrend({
  data,
  color = "var(--accent)",
  height = 60,
  labels
}: {
  data: TrendPoint[]
  color?: string
  height?: number
  labels?: string[]
}): ReactElement {
  const values = data.map((d) => (typeof d === "number" ? d : d.v));
  const max = Math.max(...values, 1);
  const n = values.length;
  const pts = values.map((v, i) => [(i / (n - 1)) * 100, 30 - (v / max) * 25 - 2]);
  const line = pts.map((p) => p.join(",")).join(" ");
  const area = `0,30 ${line} 100,30`;
  return (
    <div>
      <svg className="line-trend" viewBox="0 0 100 32" preserveAspectRatio="none" style={{ height }}>
        {[8, 16, 24].map((y) => (
          <line key={y} x1="0" x2="100" y1={y} y2={y} className="grid-line" vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={area} fill={color} fillOpacity="0.07" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.5"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      {labels && (
        <div className="trend-labels">
          {labels.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      )}
    </div>
  );
}

interface BarRow {
  name: string
  v: number
  val: string
  color?: string
}

/* — Horizontal bar list — */
function BarList({ rows, max, neutral }: { rows: BarRow[]; max?: number; neutral?: boolean }): ReactElement {
  const m = max || Math.max(...rows.map((r) => r.v), 1);
  return (
    <div className="bar-list">
      {rows.map((r, i) => (
        <div className="bar-row" key={i}>
          <span className="bar-name" title={r.name}>{r.name}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: (r.v / m) * 100 + "%", background: neutral ? "var(--text-3)" : r.color }} />
          </span>
          <span className="bar-val">{r.val}</span>
        </div>
      ))}
    </div>
  );
}

/* — Vertical mini bars (peak hours) — */
function MiniBars({ data, peakColor = "var(--accent)" }: { data: number[]; peakColor?: string }): ReactElement {
  const max = Math.max(...data, 1);
  return (
    <div className="mini-bars">
      {data.map((v, i) => (
        <span key={i} className="mini-bar"
          style={{ height: Math.max(2, (v / max) * 100) + "%", background: v === max ? peakColor : "var(--text-4)" }} />
      ))}
    </div>
  );
}

function AnCard({ title, sub, children, wide }: { title: string; sub?: string; children: ReactNode; wide?: boolean }): ReactElement {
  return (
    <div className={"an-card" + (wide ? " wide" : "")}>
      <div className="an-card-head">
        <span className="an-card-title">{title}</span>
        {sub && <span className="an-card-sub">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

export function StatsPage(): ReactElement {
  const [a, setA] = useState<AnalyticsSummary | null>(null)
  // In-progress conversations = whatever is streaming right now (live renderer state); total from the summary.
  const streamingCount = useChat((s) => Object.values(s.streaming).filter(Boolean).length)
  useEffect(() => {
    void window.api.analytics.summary().then(setA)
  }, [])

  if (!a) return <div className="studio-analytics"><div className="an-foot">Loading analytics…</div></div>

  const expertRows = a.usage.byExpert.map((r) => { const e = expertMeta(r.id); return { name: e.name, v: r.v, val: fmtTokens(r.v), color: e.color } })
  const modelRows = a.usage.byModel.map((r) => ({ name: r.label, v: r.v, val: fmtTokens(r.v), color: FAMILY_COLOR[providerOf(r.label)] ?? 'var(--text-3)' }))
  const providerRows = a.usage.byProvider.map((r) => ({ name: r.label, v: r.v, val: fmtTokens(r.v), color: FAMILY_COLOR[r.label] ?? 'var(--text-3)' }))
  const memRows = a.memory.perExpert.map((r) => { const e = expertMeta(r.id); return { name: e.name, v: r.v, val: String(r.v), color: e.color } })
  const ma = expertMeta(a.activity.mostActive.id)
  const layerMax = a.memory.layers.reduce((s, l) => s + l.v, 0) || 1
  // Verification: gated-step closures (Gate B) + background e2e verdicts (Gate C). Hide zero rows —
  // the fixed-order lists arrive zeros-included for stability, but an all-zero bar is noise.
  const gateBTotal = a.verification.gateB.reduce((s, r) => s + r.v, 0)
  const gateCTotal = a.verification.gateC.reduce((s, r) => s + r.v, 0)
  const gateBRows = a.verification.gateB.filter((r) => r.v > 0).map((r) => ({ name: r.outcome, v: r.v, val: String(r.v), color: GATE_COLOR[r.outcome] ?? 'var(--text-3)' }))
  const gateCRows = a.verification.gateC.filter((r) => r.v > 0).map((r) => ({ name: r.outcome.toLowerCase(), v: r.v, val: String(r.v), color: GATE_COLOR[r.outcome] ?? 'var(--text-3)' }))
  const verifRows = a.verification.byExpert.map((r) => {
    const e = expertMeta(r.id)
    return { name: e.name, v: r.total ? r.ok / r.total : 0, val: `${r.ok}/${r.total}`, color: e.color }
  })
  // M5 panel A/B (panel-examine §10): the amplifier's measured catches vs the floor-only baseline,
  // read off the built-in floor/subject/aggregate row split. "caught beyond floor" is the A-signal (floor would
  // have shipped it, a subject flagged); "false reds" is the B-cost (subject false positives).
  const examineImpact = a.verification.examineImpact
  const subjectRows = [
    { name: "caught beyond floor", v: examineImpact.caughtBeyondFloor, val: String(examineImpact.caughtBeyondFloor), color: GATE_COLOR.pass },
    { name: "subject catches", v: examineImpact.catches, val: String(examineImpact.catches), color: GATE_COLOR.fixed },
    { name: "false reds", v: examineImpact.falseReds, val: String(examineImpact.falseReds), color: GATE_COLOR.unresolved }
  ].filter((r) => r.v > 0)
  const total = a.usage.conversationsTotal
  const inProgress = Math.min(streamingCount, total)
  const inPct = a.usage.tokensToday > 0 ? Math.round((a.usage.tokensIn / a.usage.tokensToday) * 100) : 0

  return (
    <div className="studio-analytics">
      {/* ——— USAGE ——— */}
      <div className="an-section">
        <div className="an-section-head">Usage</div>
        <div className="an-grid">
          <AnCard title="Tokens">
            <div className="token-totals">
              <div className="tt-cell"><div className="tt-num">{fmtTokens(a.usage.tokensToday)}</div><div className="tt-lbl">today</div></div>
              <div className="tt-cell"><div className="tt-num">{fmtTokens(a.usage.tokensAllTime)}</div><div className="tt-lbl">all-time</div></div>
            </div>
            <div className="an-mini-label" style={{ marginTop: 14 }}>Today · in / out</div>
            <div className="io-split">
              <div className="io-row"><span className="io-label">In</span><span className="io-track"><span className="io-fill in" style={{ width: inPct + "%" }} /></span><span className="io-val">{fmtTokens(a.usage.tokensIn)}</span></div>
              <div className="io-row"><span className="io-label">Out</span><span className="io-track"><span className="io-fill out" style={{ width: 100 - inPct + "%" }} /></span><span className="io-val">{fmtTokens(a.usage.tokensOut)}</span></div>
            </div>
            <div className="an-divider" />
            <div className="an-mini-label">Tokens · last 7 days</div>
            <LineTrend data={a.usage.byDay.map((d) => d.v)} labels={a.usage.byDay.map((d) => d.d)} />
          </AnCard>

          <AnCard title="Conversations">
            <div className="stat-triple">
              <div className="st-cell"><div className="st-num">{inProgress}</div><div className="st-lbl">in progress</div></div>
              <div className="st-cell"><div className="st-num">{total - inProgress}</div><div className="st-lbl">done</div></div>
              <div className="st-cell"><div className="st-num">{total}</div><div className="st-lbl">total</div></div>
            </div>
            <div className="an-divider" />
            <div className="an-mini-label">By provider</div>
            {providerRows.length ? <BarList rows={providerRows} /> : <div className="an-mini-label">No usage yet.</div>}
          </AnCard>

          <AnCard title="By expert">
            {expertRows.length ? <BarList rows={expertRows} /> : <div className="an-mini-label">No usage yet.</div>}
          </AnCard>

          <AnCard title="By model">
            {modelRows.length ? <BarList rows={modelRows} /> : <div className="an-mini-label">No usage yet.</div>}
          </AnCard>
        </div>
      </div>

      {/* ——— MEMORY & GROWTH ——— */}
      <div className="an-section">
        <div className="an-section-head">Memory &amp; growth <span className="an-section-note">— how well the team knows you</span></div>
        <div className="an-grid">
          <AnCard title="Memory by expert" sub={a.memory.total + " total"}>
            {memRows.length ? <BarList rows={memRows} /> : <div className="an-mini-label">Nothing learned yet.</div>}
          </AnCard>

          <AnCard title="Memory layers">
            <div className="stacked-bar">
              {a.memory.layers.map((l) => (
                <span key={l.key} className={"stk-seg " + l.key.toLowerCase()} style={{ width: (l.v / layerMax) * 100 + "%" }} />
              ))}
            </div>
            <div className="layer-legend">
              {a.memory.layers.map((l) => (
                <div className="ll-row" key={l.key}>
                  <span className={"ll-dot " + l.key.toLowerCase()} />
                  <span className="ll-key">{l.key}</span>
                  <span className="ll-hint">{l.hint}</span>
                  <span className="ll-val">{l.v}</span>
                </div>
              ))}
            </div>
          </AnCard>

          <AnCard title="Self-learning" sub="getting to know you">
            <div className="learn-stats">
              <div className="learn-cell"><div className="learn-num">{a.memory.learning.approved}</div><div className="learn-lbl">approved</div></div>
              <div className="learn-cell"><div className="learn-num">{a.memory.learning.corrected}</div><div className="learn-lbl">corrected</div></div>
            </div>
            <div className="an-divider" />
            <div className="an-mini-label">Learning events · last 4 weeks</div>
            <LineTrend data={a.memory.learning.byWeek} color="var(--exp-editor)" height={52} labels={["W1", "W2", "W3", "W4"]} />
          </AnCard>
        </div>
      </div>

      {/* ——— VERIFICATION ——— */}
      <div className="an-section">
        <div className="an-section-head">Verification <span className="an-section-note">— does the work hold up</span></div>
        <div className="an-grid">
          <AnCard title="Gated steps" sub={gateBTotal + " verified"}>
            {gateBRows.length ? <BarList rows={gateBRows} /> : <div className="an-mini-label">No gated runs yet — dispatch a code-change task to see verification outcomes.</div>}
            {gateCTotal > 0 && (
              <>
                <div className="an-divider" />
                <div className="an-mini-label">e2e runs · {gateCTotal}</div>
                <BarList rows={gateCRows} />
              </>
            )}
          </AnCard>

          <AnCard title="Pass rate by expert" sub="verified-good / gated">
            {verifRows.length ? <BarList rows={verifRows} max={1} /> : <div className="an-mini-label">No gated runs yet.</div>}
          </AnCard>

          <AnCard title="Panel examine" sub={examineImpact.steps + " amplified"}>
            {examineImpact.steps ? (
              subjectRows.length ? (
                <BarList rows={subjectRows} />
              ) : (
                <div className="an-mini-label">{examineImpact.steps} step(s) amplified — every subject passed, nothing flagged.</div>
              )
            ) : (
              <div className="an-mini-label">No panel runs yet — high-risk code changes trigger extra reviewers.</div>
            )}
          </AnCard>
        </div>
      </div>

      {/* ——— ACTIVITY ——— */}
      <div className="an-section">
        <div className="an-section-head">Activity</div>
        <div className="an-grid">
          <AnCard title="Activity trend" sub="last 14 days" wide>
            <LineTrend data={a.activity.byDay} color="var(--exp-engineer)" height={68} />
          </AnCard>

          <AnCard title="Most active">
            <div className="most-active">
              <Avatar expert={STUDIO_DATA.EXPERT_BY_ID[a.activity.mostActive.id] ?? null} size={34} />
              <div>
                <div className="ma-name">{ma.name}</div>
                <div className="ma-sub">{a.activity.mostActive.today} today · {a.activity.mostActive.week} this week</div>
              </div>
            </div>
            <div className="an-divider" />
            <div className="an-mini-label">Tool calls · today</div>
            <div className="tool-list">
              {a.activity.tools.length === 0 ? (
                <div className="an-mini-label">No tool calls today.</div>
              ) : (
                a.activity.tools.map((t) => {
                  const Ico = Icons[toolIconName(t.label)]
                  return (
                    <div className="tool-row" key={t.label}>
                      <span className="tool-ic"><Ico size={14} /></span>
                      <span className="tool-lbl">{t.label}</span>
                      <span className="tool-val">{t.v}</span>
                    </div>
                  )
                })
              )}
            </div>
          </AnCard>

          <AnCard title="Peak hours" sub="by hour · today">
            <MiniBars data={a.activity.peakHours} />
            <div className="hour-labels"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
          </AnCard>
        </div>
      </div>

      <div className="an-foot">Local analytics · stays on this device · no usage leaves the app</div>
    </div>
  )
}
