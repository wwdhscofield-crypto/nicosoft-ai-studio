/* ============================================================
   NicoSoft AI Studio — Memory Live
   Full-screen 3D holographic energy core built from the memory
   pool (three.js): deep space, orange-gold neurons arranged as
   a sci-fi hologram core, faint links, pulses riding them.
   · Node size ∝ tokens; brightness ∝ recall recency (90-day
     linear decay); color temperature by source — explicit
     (white-hot) > user > auto (ember).
   · Shape: near-spherical but deliberately irregular — a
     blazing nucleus wrapped in concentric particle shells that
     are broken by random patch holes (frayed rims, warped
     radii — never a perfect sphere), plus slow orbital arc
     rings and radial glints. Shared memories sink toward the
     nucleus, each role claims a mid-shell angular sector. A
     weak force pass (anchor springs + local repulsion +
     clamped edge springs) only adds organic micro-motion —
     the sampling sets the shape.
   · Background: ~1850 micro particles (one Points draw call)
     wired with same-shell tangential links, so the mesh
     streams along the shells like orbital tracks; random
     twinkles plus 15-30 pulses flowing along main edges and
     background links keep it "thinking".
   · Edges: learned from the same conversation, OR content
     Jaccard > 0.35 (CJK-bigram tokens, mirroring the
     extractor's dedup metric).
   · Live: `memory:recalled` (pushed by the backend the moment
     recall() injects memories into a turn) flashes the recalled
     nodes and fires pulses down their edges.
   ============================================================ */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Icons } from '@/components/icons'
import { STUDIO_DATA } from '@/data/studio-data'
import type { MemoryDto } from '@/lib/api'
import '@/styles/memory-live.css'

// ---- tuning ----
const JACCARD_EDGE = 0.35 // content similarity above this links two memories
const MAX_SIM_EDGES_PER_NODE = 8 // cap similarity links per node so dense topics don't hairball
const HEAT_DECAY_DAYS = 90 // recall heat fades linearly to base brightness over this window
const FLASH_SECONDS = 1.5 // live recall flash decay
const BURST_POOL = 64 // max concurrent recall-burst pulses
const BURST_EDGES_PER_NODE = 6 // pulses fired per recalled node (sampled when degree is higher)

// ---- holographic core shape (all proportions centralized; world size = CORE_R × stage scale) ----
// Near-spherical but irregular by design: a blazing nucleus, concentric particle shells broken by
// random patch holes, loose inter-shell dust, orbital arc rings, and radial glints.
const CORE_R = 30 // overall core radius (world units before stage scale)
const NUCLEUS_T = 0.18 // blazing nucleus radius, fraction of CORE_R
const NUCLEUS_SHARE = 0.3 // share of free samples landing in the nucleus — tiny volume → very dense
const NUCLEUS_POW = 0.5 // nucleus radial exponent (u^pow; > 1/3 piles density toward the center)
const NUCLEUS_BRIGHT = 1.45 // nucleus particles burn brighter than shell particles
const SCATTER_SHARE = 0.08 // loose dust between nucleus and outer shell — breaks clean banding
const SHELL_TS = [0.46, 0.7, 0.97] // base shell radii, fractions of CORE_R (innermost → outermost)
const SHELL_SHARE = [0.17, 0.28, 0.55] // how the shell samples split across the three shells
const SHELL_THICK = 0.045 // radial half-thickness of one shell band
const SHELL_WARP = 0.05 // directional radius warp (sin-product noise) — shells wobble, never perfect
const SHELL_HOLE_MIN = 3 // patch holes carved per shell …
const SHELL_HOLE_MAX = 6 // … so every shell reads visibly incomplete
const HOLE_ANG_MIN = 0.28 // hole angular radius range (radians)
const HOLE_ANG_MAX = 0.6
const HOLE_FRAY = 0.35 // outer fraction of a hole rim where rejection is probabilistic → ragged edges
const HOLE_SEED = 0x9a771c3 // fixed seed for the hole layout — the same broken shells every open
// main-layer region assignment inside the core
const MAIN_SHARED_TMAX = 0.4 // shared memories sink toward the nucleus (radial band 0..this)
const MAIN_ROLE_TMIN = 0.36 // role sectors occupy the mid-shell band …
const MAIN_ROLE_TMAX = 0.7 // … and stay clear of the broken outermost shell
const ROLE_DIR_SPREAD = 0.6 // angular footprint of one role sector

// ---- orbital arc rings (the hologram signature) ----
const RING_COUNT = 7 // broken orbital rings; one Points each (shared material) → ≤8 extra draw calls
const RING_R_MIN = 0.55 // ring radius range, fraction of CORE_R
const RING_R_MAX = 1.18
const RING_KEEP_MIN = 0.4 // each ring keeps only this fraction of its circumference …
const RING_KEEP_MAX = 0.7
const RING_SEG_MIN = 2 // … split into 2-4 separate arc segments
const RING_SEG_MAX = 4
const RING_STEP = 0.6 // linear particle spacing along an arc (world units before stage scale)
const RING_SIZE = 0.72 // ring particle size (world units before stage scale)
const RING_OPACITY = 0.8
const RING_THICK = 0.3 // slight out-of-plane jitter so arcs read as particle streams, not vector lines
const RING_SPIN_MIN = 0.015 // per-ring spin about its own axis (rad/s) — barely perceptible drift
const RING_SPIN_MAX = 0.055
const RING_TINT_R = 1.0 // arc tint — golden, a step hotter than the dim ember shells
const RING_TINT_G = 0.62
const RING_TINT_B = 0.26

// ---- core highlight: center glow + radial glints ----
const HEART_GLOW_SCALE = 17 // big soft halo sprite around the nucleus (world units before scale)
const HEART_GLOW_OPACITY = 0.5
const HEART_HOT_SCALE = 7.5 // tight white-hot kernel — the brightest thing on stage
const HEART_HOT_OPACITY = 0.92
const RAY_COUNT = 14 // thin radial lines from the nucleus, fading outward (one LineSegments)
const RAY_IN_T = 0.08 // ray start radius, fraction of CORE_R
const RAY_OUT_MIN = 0.72 // ray end radius range, fraction of CORE_R
const RAY_OUT_MAX = 1.05
const RAY_OPACITY = 0.5

// ---- background micro-particle layer ----
const BG_COUNT = 1850 // tiny core particles (nucleus + shells), one THREE.Points draw call
const BG_SIZE = 0.85 // point size (world units, before stage scale)
const BG_OPACITY = 0.5
const BG_R = 0.79 // base tint — dim ember orange (#c96416)
const BG_G = 0.39
const BG_B = 0.09
const BG_LINK_DIST = 5.5 // orbit-flow links: neighbor cutoff (world units, before stage scale)
const BG_LINK_K = 2 // tangential neighbors wired per micro particle
const BG_LINK_OPACITY = 0.055 // very faint — texture, not signal
const LINK_SHELL_DR = 3.2 // same-shell gate: skip candidates whose radius differs more than this
const LINK_RADIAL_PENALTY = 6 // score penalty on radially-aligned pairs → links flow along the shells
const TWINKLE_MAX = 16 // max concurrent background twinkles ("thinking" flicker)
const TWINKLE_RATE = 9 // average twinkle spawns per second
const TWINKLE_BOOST = 2.6 // brightness gain at twinkle peak

// ---- flow pulses (one THREE.Points draw call riding main edges + background links) ----
const FLOW_POOL = 28 // concurrent travelling pulses (spec: 15-30)
const FLOW_BG_SHARE = 0.55 // chance a respawned pulse rides a background link
const FLOW_SIZE = 1.45 // point size (world units, before stage scale)

// physics — node homes are already core-shaped, so forces only fine-tune: a firm anchor spring
// holds the silhouette while weak repulsion/springs add local organic motion.
const K_HOME = 3 // anchor spring back to the sampled core point (keeps the core shape)
const K_SPRING = 0.5 // edge spring stiffness — weak, must not pull the core apart
const SPRING_REST = 5.5 // edge rest length
const SPRING_STRETCH_MAX = 10 // clamp spring stretch so long similarity edges cannot collapse sectors
const REPULSE = 36 // gentle pairwise repulsion (∝ 1/d²) for local spacing only
const REPULSE_CUT2 = 144 // repulsion cutoff distance², keeps the O(n²) loop cheap
const DAMP_PER_S = 0.002 // velocity retained after 1s — strong damping, settles into drift
const VEL_MAX = 24

// ---- stage growth ----
// The core GROWS with the memory pool — knowledge volume ∝ count, radius ∝ ∛, so it reads as a brain
// filling out rather than a fixed sphere getting denser: a near-empty pool starts just above the demo
// replica (~0.67), GROWTH_REF memories reach the original full size (1.0), and MAX_POOL (~200, the
// prune cap) lands around 1.22 — GROWTH_MAX only guards the frame, the fixed camera never clips.
// Computed once per open; in-session growth is a rare event not worth live geometry rebuilds.
const GROWTH_REF = 60 // memory count that renders at the original full stage size
const GROWTH_MIN = 0.55
const GROWTH_MAX = 1.35
function stageScaleForCount(n: number): number {
  return Math.min(GROWTH_MAX, Math.max(GROWTH_MIN, GROWTH_MIN + 0.45 * Math.cbrt(n / GROWTH_REF)))
}

// ---- demo cloud (empty state) ----
// With zero memories the view must still feel alive: a synthetic core runs through the exact
// same pipeline (buildEdges → physics → pulses), only scaled down, with hover/click disabled.
const DEMO_SCALE = 0.6 // demo stage is a ~60% replica of the real core — present, not center stage
const DEMO_COUNT = 70 // dense enough that the demo reads as a core, not scattered stars
// Demo contents are one unique alphanumeric token each (word + running index) — zero shared
// tokens, so the Jaccard pass never fabricates similarity edges; the only demo links are the
// per-cluster conversation threads wired via sourceConvId.
const DEMO_WORDS = [
  'aurora', 'basalt', 'cinder', 'dune', 'ember', 'fjord', 'glacier', 'harbor',
  'isle', 'juniper', 'kelp', 'lagoon', 'meadow', 'nebula', 'orchard', 'prairie',
  'quarry', 'reef', 'summit', 'tundra', 'umbra', 'vale', 'willow', 'zephyr'
]

// Color temperature by source: explicit burns white-hot, user is the signature orange, auto a dim ember.
const SRC_TINT: Record<string, { glow: number; core: number }> = {
  explicit: { glow: 0xffc890, core: 0xfff3df },
  user: { glow: 0xff9a3c, core: 0xffd9ae },
  auto: { glow: 0xc96416, core: 0xff9a3c }
}
const EDGE_R = 1.0
const EDGE_G = 0.55
const EDGE_B = 0.22

interface LiveEdge {
  a: number
  b: number
}

interface LiveNode {
  mem: MemoryDto
  home: THREE.Vector3
  pos: THREE.Vector3
  vel: THREE.Vector3
  rpos: THREE.Vector3 // render position = pos + breathing offset
  baseGlow: number // heat-driven glow opacity
  baseCore: number
  glowScale: number
  coreScale: number
  phase: number // breathing phase
  flash: number // live recall burst, 1 → 0 over FLASH_SECONDS
  vis: number // hover dim factor, smoothed toward its target
  glow: THREE.Sprite
  glowMat: THREE.SpriteMaterial
  core: THREE.Mesh
  coreMat: THREE.MeshBasicMaterial
  neighbors: Set<number>
  edges: number[]
}

// One-shot recall burst riding a main edge (sprite-based; ambient flow pulses are a Points layer).
interface BurstPulse {
  active: boolean
  edge: number
  rev: boolean // travel b→a instead of a→b
  t: number
  dur: number
  sprite: THREE.Sprite
  mat: THREE.SpriteMaterial
}

// ---- pure helpers ----

// 0..1 recall heat: 1 = recalled just now, fading linearly to 0 over HEAT_DECAY_DAYS. Never-recalled
// rows (pre-upgrade data) sit at 0 and render at base brightness.
function recallHeat(iso: string | null): number {
  if (!iso) return 0
  const days = (Date.now() - Date.parse(iso)) / 86_400_000
  if (!Number.isFinite(days)) return 0
  return Math.max(0, Math.min(1, 1 - days / HEAT_DECAY_DAYS))
}

// Synthetic memories for the empty-state demo core: a shared nucleus + three role sectors, all
// three size tiers (tokens) and all three source temperatures evenly mixed, one small conversation
// thread per cluster (rails for the travelling pulses), recall recency spread across the heat
// window so brightness has depth. Fed to the same buildGraph path as real data.
function buildDemoMemories(): MemoryDto[] {
  const now = Date.now()
  const out: MemoryDto[] = []
  for (let i = 0; i < DEMO_COUNT; i++) {
    const tokens = [10, 45, 110][i % 3] // small / medium / large, evenly mixed
    const source = i % 6 === 0 ? 'explicit' : i % 2 === 1 ? 'user' : 'auto'
    const layer = i < 26 ? 'shared' : 'role' // 26 in the nucleus + 16/14/14 across three sectors
    const roleId = i < 26 ? null : i < 42 ? 'demo-a' : i < 56 ? 'demo-b' : 'demo-c'
    // one short thread per cluster → 10 + 6 + 6 + 6 + 6 = 34 edges total
    const conv =
      i < 5
        ? 'demo-c1'
        : i >= 8 && i < 12
          ? 'demo-c2'
          : i >= 26 && i < 30
            ? 'demo-c3'
            : i >= 42 && i < 46
              ? 'demo-c4'
              : i >= 56 && i < 60
                ? 'demo-c5'
                : null
    // every other node was "recalled" 3..79 days ago → heat spans ~0.97 down to ~0.12
    const recalled = i % 2 === 0 ? new Date(now - (3 + i * 1.1) * 86_400_000).toISOString() : null
    const created = new Date(now - (DEMO_COUNT - i) * 86_400_000).toISOString()
    out.push({
      id: `demo-${i}`,
      layer,
      roleId,
      type: 'fact',
      content: DEMO_WORDS[i % DEMO_WORDS.length] + String(i), // unique single token per node
      source,
      tokens,
      sourceConvId: conv,
      lastRecalledAt: recalled,
      createdAt: created,
      updatedAt: created
    })
  }
  return out
}

function timeAgo(iso: string | null): string | null {
  if (!iso) return null
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return null
  if (s < 60) return 'just now'
  const m = s / 60
  if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)}h ago`
  const d = h / 24
  if (d < 30) return `${Math.floor(d)}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

// CJK-aware tokenizer + Jaccard — trimmed renderer copy of the pair in main's memory.service.ts, so
// similarity edges match the backend's notion of "related" without an IPC round-trip. CJK runs become
// character bigrams; non-CJK words stay whole tokens.
function tokenize(s: string): Set<string> {
  const out = new Set<string>()
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  for (const w of norm.split(/\s+/).filter(Boolean)) {
    const runs = w.match(/[぀-ヿ㐀-鿿가-힯]+|[^぀-ヿ㐀-鿿가-힯]+/gu) ?? []
    for (const run of runs) {
      if (/[぀-ヿ㐀-鿿가-힯]/.test(run)) {
        if (run.length === 1) out.add(run)
        else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
      } else out.add(run)
    }
  }
  return out
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// Hybrid edge semantics: ① memories learned from the same conversation form a thread (fully connected
// when small, chained in creation order when large); ② content similarity above JACCARD_EDGE links
// related knowledge across conversations, strongest first under a per-node degree cap.
function buildEdges(memories: MemoryDto[]): LiveEdge[] {
  const edges: LiveEdge[] = []
  const seen = new Set<string>()
  const push = (a: number, b: number): boolean => {
    if (a === b) return false
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    if (seen.has(key)) return false
    seen.add(key)
    edges.push({ a, b })
    return true
  }

  const byConv = new Map<string, number[]>()
  memories.forEach((m, i) => {
    if (!m.sourceConvId) return
    const g = byConv.get(m.sourceConvId)
    if (g) g.push(i)
    else byConv.set(m.sourceConvId, [i])
  })
  for (const group of byConv.values()) {
    group.sort((x, y) => (memories[x].createdAt < memories[y].createdAt ? -1 : 1))
    if (group.length <= 5) {
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) push(group[i], group[j])
    } else {
      for (let i = 1; i < group.length; i++) push(group[i - 1], group[i])
    }
  }

  const sets = memories.map((m) => tokenize(m.content))
  const sims: { a: number; b: number; s: number }[] = []
  for (let i = 0; i < memories.length; i++)
    for (let j = i + 1; j < memories.length; j++) {
      const s = jaccardSets(sets[i], sets[j])
      if (s > JACCARD_EDGE) sims.push({ a: i, b: j, s })
    }
  sims.sort((x, y) => y.s - x.s)
  const degree = new Array<number>(memories.length).fill(0)
  for (const e of sims) {
    if (degree[e.a] >= MAX_SIM_EDGES_PER_NODE || degree[e.b] >= MAX_SIM_EDGES_PER_NODE) continue
    if (push(e.a, e.b)) {
      degree[e.a]++
      degree[e.b]++
    }
  }
  return edges
}

// Evenly spread `count` directions on a sphere (Fibonacci lattice) — one per role sector.
function fibonacciSphere(count: number, radius: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = count === 1 ? 0 : 1 - (2 * (i + 0.5)) / count
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const th = golden * i
    pts.push(new THREE.Vector3(Math.cos(th) * r * radius, y * radius, Math.sin(th) * r * radius))
  }
  return pts
}

function randInSphere(r: number): THREE.Vector3 {
  for (;;) {
    const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
    if (v.lengthSq() <= 1) return v.multiplyScalar(r)
  }
}

// Deterministic PRNG (mulberry32) — the core is sampled with a fixed seed so every open shows
// the same well-formed silhouette instead of gambling on Math.random.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Uniform direction on the unit sphere, driven by the given PRNG.
function randUnitVec(rng: () => number): THREE.Vector3 {
  const z = rng() * 2 - 1
  const a = rng() * Math.PI * 2
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z)
}

interface CoreSampleOpts {
  dir?: THREE.Vector3 // bias samples around this unit direction (role sectors)
  dirSpread?: number // jitter radius mixed into `dir` before normalizing
  tMin?: number // radial band: 0 = core center …
  tMax?: number // … 1 = outer shell radius
}

// Patch holes carved into each particle shell. Built once from a fixed seed so the broken-shell
// layout is deterministic — the same asymmetric, incomplete shells on every open.
interface ShellHole {
  dir: THREE.Vector3 // hole center direction (unit)
  ang: number // hole angular radius (radians)
}
const SHELL_HOLES: ShellHole[][] = (() => {
  const hr = mulberry32(HOLE_SEED)
  return SHELL_TS.map(() => {
    const n = SHELL_HOLE_MIN + Math.floor(hr() * (SHELL_HOLE_MAX - SHELL_HOLE_MIN + 1))
    return Array.from({ length: n }, () => ({
      dir: randUnitVec(hr),
      ang: HOLE_ANG_MIN + hr() * (HOLE_ANG_MAX - HOLE_ANG_MIN)
    }))
  })
})()

// True when direction `d` falls inside one of the shell's patch holes. The inner part of a hole
// always rejects; across the outer HOLE_FRAY band rejection turns probabilistic, which dithers
// the rim into ragged, broken edges instead of clean circular cutouts.
function inShellHole(shell: number, d: THREE.Vector3, rng: () => number): boolean {
  for (const h of SHELL_HOLES[shell]) {
    const a = Math.acos(Math.min(1, Math.max(-1, d.dot(h.dir))))
    if (a >= h.ang) continue
    const inner = h.ang * (1 - HOLE_FRAY)
    if (a <= inner || rng() < (h.ang - a) / (h.ang - inner)) return true
  }
  return false
}

// Pure core-volume sampler. With a radial band and/or direction (main/shared neurons) it returns
// a volumetric sample inside that band/sector — no hole masks there, so node anchors stay exactly
// where the physics expects them. Free samples (background) draw the full hologram: a blazing
// nucleus, loose inter-shell dust, and three broken shells (patch holes with frayed rims, jittered
// band radius, per-direction warp). All knobs live in the core-shape constants.
function sampleCorePoint(rng: () => number, opts: CoreSampleOpts = {}): THREE.Vector3 {
  if (opts.dir || opts.tMin !== undefined || opts.tMax !== undefined) {
    const d = opts.dir
      ? opts.dir
          .clone()
          .addScaledVector(randUnitVec(rng), (opts.dirSpread ?? 0.5) * Math.cbrt(rng()))
          .normalize()
      : randUnitVec(rng)
    const tMin = opts.tMin ?? 0
    const tMax = opts.tMax ?? 1
    // t = u^(1/3) keeps the band sample uniform in volume
    return d.multiplyScalar((tMin + (tMax - tMin) * Math.cbrt(rng())) * CORE_R)
  }
  const u = rng()
  // blazing nucleus: a tiny volume holding a large share of samples → very dense, center-piled
  if (u < NUCLEUS_SHARE)
    return randUnitVec(rng).multiplyScalar(Math.pow(rng(), NUCLEUS_POW) * NUCLEUS_T * CORE_R)
  // sparse dust between nucleus and outer shell keeps the banding from looking machined
  if (u < NUCLEUS_SHARE + SCATTER_SHARE) {
    const t = NUCLEUS_T + (1 - NUCLEUS_T) * Math.cbrt(rng())
    return randUnitVec(rng).multiplyScalar(t * CORE_R)
  }
  // broken shells: pick one by share, then rejection-sample a direction outside its patch holes
  let shell = SHELL_TS.length - 1
  {
    const w = rng()
    let acc = 0
    for (let s = 0; s < SHELL_TS.length; s++) {
      acc += SHELL_SHARE[s]
      if (w < acc) {
        shell = s
        break
      }
    }
  }
  let d = randUnitVec(rng)
  // bounded retries — if a draw is this unlucky, one stray particle inside a hole is harmless
  for (let tries = 0; tries < 40 && inShellHole(shell, d, rng); tries++) d = randUnitVec(rng)
  // noisy shell radius: band jitter + directional warp — never a perfect sphere
  const warp =
    Math.sin(d.x * 5.3 + d.y * 3.7) *
    Math.sin(d.y * 4.9 - d.z * 4.1) *
    Math.sin(d.z * 5.9 + d.x * 3.1)
  const t = SHELL_TS[shell] + (rng() * 2 - 1) * SHELL_THICK + SHELL_WARP * warp
  return d.multiplyScalar(t * CORE_R)
}

// Shared radial-gradient glow texture (white — tinted per node/pulse by material color).
function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.22, 'rgba(255,255,255,0.5)')
    grad.addColorStop(0.55, 'rgba(255,255,255,0.12)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 128, 128)
  }
  return new THREE.CanvasTexture(c)
}

// One force-simulation step: anchor spring toward the sampled core point + pairwise repulsion
// (with cutoff) + clamped edge springs, integrated with strong damping. Forces are deliberately
// weak relative to the anchor so the simulation only adds organic micro-motion — the core
// silhouette set by the sampling must survive.
// `scale` shrinks the whole system uniformly (demo cloud): lengths × s and the 1/d² repulsion
// strength × s³ reproduce the exact same equilibrium shape at s× the size.
function stepPhysics(nodes: LiveNode[], edges: LiveEdge[], dt: number, scale: number): void {
  const rest = SPRING_REST * scale
  const stretchMax = SPRING_STRETCH_MAX * scale
  const repulse = REPULSE * scale * scale * scale
  const cut2 = REPULSE_CUT2 * scale * scale
  const d = new THREE.Vector3()
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]
      d.copy(a.pos).sub(b.pos)
      const dist2 = d.lengthSq()
      if (dist2 > cut2) continue
      const k = repulse / (dist2 * Math.sqrt(dist2) + 0.6) // direction-normalized 1/d² falloff
      a.vel.addScaledVector(d, k * dt)
      b.vel.addScaledVector(d, -k * dt)
    }
  }
  for (const e of edges) {
    const a = nodes[e.a]
    const b = nodes[e.b]
    d.copy(b.pos).sub(a.pos)
    const dist = d.length() || 0.001
    const stretch = Math.max(-stretchMax, Math.min(stretchMax, dist - rest))
    const k = (K_SPRING * stretch) / dist
    a.vel.addScaledVector(d, k * dt)
    b.vel.addScaledVector(d, -k * dt)
  }
  const damp = Math.pow(DAMP_PER_S, dt)
  for (const n of nodes) {
    n.vel.addScaledVector(d.copy(n.home).sub(n.pos), K_HOME * dt)
    n.vel.multiplyScalar(damp)
    const v = n.vel.length()
    if (v > VEL_MAX) n.vel.multiplyScalar(VEL_MAX / v)
    n.pos.addScaledVector(n.vel, dt)
  }
}

function samples<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

interface TipState {
  mem: MemoryDto
  x: number
  y: number
}

export function MemoryLive({ onClose }: { onClose: () => void }): ReactElement {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const tipBoxRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [memories, setMemories] = useState<MemoryDto[] | null>(null)
  const [stats, setStats] = useState<{ nodes: number; links: number } | null>(null)
  const [tip, setTip] = useState<TipState | null>(null)
  const [glFailed, setGlFailed] = useState(false)

  // Esc closes (× button below does the same).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let alive = true
    window.api.memory
      .list()
      .then((ms) => alive && setMemories(ms))
      .catch(() => alive && setMemories([]))
    return () => {
      alive = false
    }
  }, [])

  // The whole scene lives inside this one effect: build → animate → dispose. Runs once when the
  // memory list arrives; everything it allocates is torn down in the cleanup.
  useEffect(() => {
    const container = mountRef.current
    if (!container || memories === null) return
    // Empty pool → feed the very same pipeline a small synthetic cloud so the view still feels
    // alive. Hover/click are disabled in demo mode; stats stay hidden (the counts would be fake).
    const isDemo = memories.length === 0
    const data = isDemo ? buildDemoMemories() : memories
    const S = isDemo ? DEMO_SCALE : stageScaleForCount(memories.length) // uniform stage scale: layout, node size, breathing, pulses — grows with the pool

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch (err) {
      console.error('[memory-live] WebGL init failed', err)
      setGlFailed(true)
      return
    }
    const W = (): number => container.clientWidth || window.innerWidth
    const H = (): number => container.clientHeight || window.innerHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(W(), H())
    renderer.setClearColor(0x040406, 1)
    container.appendChild(renderer.domElement)
    const canvas = renderer.domElement
    canvas.style.cursor = 'grab'

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x040406, 0.0042) // additive sprites fade into the deep — depth cue
    const camera = new THREE.PerspectiveCamera(55, W() / H(), 0.1, 1200)
    camera.position.set(30, 18, 84) // three-quarter view — the core silhouette reads immediately

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.45
    controls.minDistance = 22
    controls.maxDistance = 320

    const glowTex = makeGlowTexture()
    const materials: { dispose: () => void }[] = []
    const geometries: { dispose: () => void }[] = []

    // — distant dust, for depth —
    const starCount = 360
    const starPos = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i++) {
      const v = randInSphere(1).normalize().multiplyScalar(150 + Math.random() * 280)
      starPos[i * 3] = v.x
      starPos[i * 3 + 1] = v.y
      starPos[i * 3 + 2] = v.z
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    const starMat = new THREE.PointsMaterial({
      map: glowTex,
      color: 0x8a6a4a,
      size: 1.7,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    geometries.push(starGeo)
    materials.push(starMat)
    scene.add(new THREE.Points(starGeo, starMat))

    // Deterministic sampling: a fixed seed gives every open the same well-formed core.
    const rng = mulberry32(0x5eedb12a)

    // — background micro-particle layer: one Points call; nucleus + broken shells draw the core —
    const bgPos = new Float32Array(BG_COUNT * 3)
    const bgCol = new Float32Array(BG_COUNT * 3)
    const bgBase = new Float32Array(BG_COUNT) // per-particle base brightness (twinkles restore it)
    const nucR = NUCLEUS_T * 1.2 * CORE_R * S // below this radius a particle counts as nucleus
    for (let i = 0; i < BG_COUNT; i++) {
      const p = sampleCorePoint(rng).multiplyScalar(S)
      bgPos[i * 3] = p.x
      bgPos[i * 3 + 1] = p.y
      bgPos[i * 3 + 2] = p.z
      // nucleus particles burn a touch brighter than the shell particles
      const b = (0.5 + 0.5 * rng()) * (p.length() < nucR ? NUCLEUS_BRIGHT : 1)
      bgBase[i] = b
      bgCol[i * 3] = BG_R * b
      bgCol[i * 3 + 1] = BG_G * b
      bgCol[i * 3 + 2] = BG_B * b
    }
    const bgGeo = new THREE.BufferGeometry()
    bgGeo.setAttribute('position', new THREE.BufferAttribute(bgPos, 3))
    bgGeo.setAttribute('color', new THREE.BufferAttribute(bgCol, 3))
    const bgMat = new THREE.PointsMaterial({
      map: glowTex,
      vertexColors: true,
      size: BG_SIZE * S,
      transparent: true,
      opacity: 0, // faded in with the intro
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    geometries.push(bgGeo)
    materials.push(bgMat)
    scene.add(new THREE.Points(bgGeo, bgMat))

    // orbit-flow links between micro particles — one faint LineSegments. Each particle wires to
    // its best same-shell, tangential neighbors: pairs are gated by |Δradius| (stay on one shell)
    // and scored with a penalty on radial alignment, so the mesh streams along the shells like
    // orbital tracks instead of cutting straight through the core.
    const bgLinks: number[] = [] // flat pairs [a, b, …] indexing into the background points
    {
      const linkSeen = new Set<number>()
      const maxD2 = BG_LINK_DIST * BG_LINK_DIST * S * S
      const maxDr = LINK_SHELL_DR * S
      const radii = new Float32Array(BG_COUNT)
      for (let i = 0; i < BG_COUNT; i++)
        radii[i] = Math.hypot(bgPos[i * 3], bgPos[i * 3 + 1], bgPos[i * 3 + 2])
      const nIdx = new Array<number>(BG_LINK_K)
      const nScore = new Array<number>(BG_LINK_K)
      for (let i = 0; i < BG_COUNT; i++) {
        const ix = bgPos[i * 3]
        const iy = bgPos[i * 3 + 1]
        const iz = bgPos[i * 3 + 2]
        const ri = radii[i]
        nIdx.fill(-1)
        nScore.fill(Infinity)
        for (let j = 0; j < BG_COUNT; j++) {
          if (j === i) continue
          if (Math.abs(radii[j] - ri) > maxDr) continue // same-shell gate
          const dx = bgPos[j * 3] - ix
          const dy = bgPos[j * 3 + 1] - iy
          const dz = bgPos[j * 3 + 2] - iz
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 >= maxD2) continue
          // radial² = squared cosine between the link direction and the radial direction at i;
          // 0 = perfectly tangential (preferred), 1 = pointing straight at / away from the center
          let radial2 = 0
          if (ri > 1e-4) {
            const dot = (dx * ix + dy * iy + dz * iz) / ri
            radial2 = (dot * dot) / Math.max(d2, 1e-8)
          }
          const score = d2 * (1 + LINK_RADIAL_PENALTY * radial2)
          if (score >= nScore[BG_LINK_K - 1]) continue
          for (let s = 0; s < BG_LINK_K; s++) {
            if (score < nScore[s]) {
              for (let q = BG_LINK_K - 1; q > s; q--) {
                nScore[q] = nScore[q - 1]
                nIdx[q] = nIdx[q - 1]
              }
              nScore[s] = score
              nIdx[s] = j
              break
            }
          }
        }
        for (const j of nIdx) {
          if (j < 0) continue
          const key = i < j ? i * BG_COUNT + j : j * BG_COUNT + i
          if (linkSeen.has(key)) continue
          linkSeen.add(key)
          bgLinks.push(i, j)
        }
      }
    }
    const bgLinkCount = bgLinks.length / 2
    const blPos = new Float32Array(bgLinkCount * 6)
    for (let i = 0; i < bgLinkCount; i++) {
      const a = bgLinks[i * 2] * 3
      const b = bgLinks[i * 2 + 1] * 3
      blPos[i * 6] = bgPos[a]
      blPos[i * 6 + 1] = bgPos[a + 1]
      blPos[i * 6 + 2] = bgPos[a + 2]
      blPos[i * 6 + 3] = bgPos[b]
      blPos[i * 6 + 4] = bgPos[b + 1]
      blPos[i * 6 + 5] = bgPos[b + 2]
    }
    const blGeo = new THREE.BufferGeometry()
    blGeo.setAttribute('position', new THREE.BufferAttribute(blPos, 3))
    const blMat = new THREE.LineBasicMaterial({
      color: 0xc96416,
      transparent: true,
      opacity: 0, // faded in with the intro
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    geometries.push(blGeo)
    materials.push(blMat)
    scene.add(new THREE.LineSegments(blGeo, blMat))

    // — orbital arc rings: broken particle rings on random tilt axes, the hologram signature.
    // One Points per ring (they share a single material) so each can spin about its own axis;
    // RING_COUNT ≤ 8 keeps the extra draw calls within budget. —
    interface SpinRing {
      obj: THREE.Points
      speed: number // signed spin rate about the ring's own axis (rad/s)
    }
    const ringMat = new THREE.PointsMaterial({
      map: glowTex,
      vertexColors: true,
      size: RING_SIZE * S,
      transparent: true,
      opacity: 0, // faded in with the intro
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    materials.push(ringMat)
    const rings: SpinRing[] = []
    for (let ri = 0; ri < RING_COUNT; ri++) {
      const rw = (RING_R_MIN + rng() * (RING_R_MAX - RING_R_MIN)) * CORE_R
      const keep = RING_KEEP_MIN + rng() * (RING_KEEP_MAX - RING_KEEP_MIN)
      const nSeg = RING_SEG_MIN + Math.floor(rng() * (RING_SEG_MAX - RING_SEG_MIN + 1))
      // random arc/gap proportions: the kept fraction splits into nSeg arcs, the rest into gaps
      const arcW: number[] = []
      const gapW: number[] = []
      let arcSum = 0
      let gapSum = 0
      for (let s = 0; s < nSeg; s++) {
        arcW.push(0.4 + rng())
        arcSum += arcW[s]
        gapW.push(0.4 + rng())
        gapSum += gapW[s]
      }
      const verts: number[] = []
      const cols: number[] = []
      let th = rng() * Math.PI * 2 // random phase so the gaps never line up across rings
      for (let s = 0; s < nSeg; s++) {
        const arc = (arcW[s] / arcSum) * keep * Math.PI * 2
        const n = Math.max(3, Math.round((arc * rw) / RING_STEP))
        for (let k = 0; k <= n; k++) {
          const a = th + arc * (k / n)
          const rj = rw * (1 + (rng() * 2 - 1) * 0.006) // slight radius jitter — not machined
          verts.push(Math.cos(a) * rj * S, (rng() * 2 - 1) * RING_THICK * S, Math.sin(a) * rj * S)
          // brightness fades across the last ~15% of each arc → frayed segment ends
          const endFade = Math.min(1, Math.min(k, n - k) / (n * 0.15))
          const b = (0.55 + 0.45 * rng()) * (0.25 + 0.75 * endFade)
          cols.push(RING_TINT_R * b, RING_TINT_G * b, RING_TINT_B * b)
        }
        th += arc + (gapW[s] / gapSum) * (1 - keep) * Math.PI * 2
      }
      const rGeo = new THREE.BufferGeometry()
      rGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
      rGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 3))
      geometries.push(rGeo)
      const pts = new THREE.Points(rGeo, ringMat)
      // random tilt: independent Euler angles give every ring its own orbital plane
      pts.rotation.set(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2)
      rings.push({
        obj: pts,
        speed: (RING_SPIN_MIN + rng() * (RING_SPIN_MAX - RING_SPIN_MIN)) * (rng() < 0.5 ? -1 : 1)
      })
      scene.add(pts)
    }

    // — core highlight: a soft halo + a white-hot kernel at the very center (brightest on stage) —
    const heartGlowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xff9a3c,
      transparent: true,
      opacity: 0, // faded in with the intro
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const heartGlow = new THREE.Sprite(heartGlowMat)
    heartGlow.scale.set(HEART_GLOW_SCALE * S, HEART_GLOW_SCALE * S, 1)
    heartGlow.raycast = () => {} // the center glow must never swallow node hover hits
    const heartHotMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xfff3df,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const heartHot = new THREE.Sprite(heartHotMat)
    heartHot.scale.set(HEART_HOT_SCALE * S, HEART_HOT_SCALE * S, 1)
    heartHot.raycast = () => {}
    materials.push(heartGlowMat, heartHotMat)
    scene.add(heartGlow, heartHot)

    // — radial glints: thin lines from the nucleus fading outward (one LineSegments). Vertex
    // colors run bright → black; under additive blending the black outer end reads transparent. —
    const rayPos = new Float32Array(RAY_COUNT * 6)
    const rayCol = new Float32Array(RAY_COUNT * 6) // outer-end colors stay 0 → fade to nothing
    for (let i = 0; i < RAY_COUNT; i++) {
      const d = randUnitVec(rng)
      const r0 = RAY_IN_T * CORE_R * S
      const r1 = (RAY_OUT_MIN + rng() * (RAY_OUT_MAX - RAY_OUT_MIN)) * CORE_R * S
      const o = i * 6
      rayPos[o] = d.x * r0
      rayPos[o + 1] = d.y * r0
      rayPos[o + 2] = d.z * r0
      rayPos[o + 3] = d.x * r1
      rayPos[o + 4] = d.y * r1
      rayPos[o + 5] = d.z * r1
      const b = 0.7 + 0.3 * rng()
      rayCol[o] = 1.0 * b
      rayCol[o + 1] = 0.72 * b
      rayCol[o + 2] = 0.4 * b
    }
    const rayGeo = new THREE.BufferGeometry()
    rayGeo.setAttribute('position', new THREE.BufferAttribute(rayPos, 3))
    rayGeo.setAttribute('color', new THREE.BufferAttribute(rayCol, 3))
    const rayMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0, // faded in with the intro
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    geometries.push(rayGeo)
    materials.push(rayMat)
    scene.add(new THREE.LineSegments(rayGeo, rayMat))

    // — graph: core regions, nodes, edges —
    const clusterKeys: string[] = []
    const clusterOf = (m: MemoryDto): string =>
      m.layer === 'shared' ? 'shared' : `${m.layer}:${m.roleId ?? 'all'}`
    for (const m of data) {
      const k = clusterOf(m)
      if (k !== 'shared' && !clusterKeys.includes(k)) clusterKeys.push(k)
    }
    // Each role cluster claims an angular sector of the mid-shell band (fibonacci directions);
    // shared memories sink toward the nucleus. All node homes are sampled inside the core volume,
    // clear of the broken outermost shell, so the anchored physics never fights the silhouette.
    const sectorDirs = fibonacciSphere(clusterKeys.length, 1)
    const sectorByKey = new Map<string, THREE.Vector3>()
    clusterKeys.forEach((k, i) => sectorByKey.set(k, sectorDirs[i]))

    const edges = buildEdges(data)
    const coreGeo = new THREE.SphereGeometry(0.5, 12, 12)
    geometries.push(coreGeo)

    const nodes: LiveNode[] = data.map((m, i) => {
      const tint = SRC_TINT[m.source] ?? SRC_TINT.user
      const heat = recallHeat(m.lastRecalledAt)
      const k = Math.sqrt(Math.max(0, Math.min(1, (m.tokens - 4) / 110))) // size ∝ tokens, clamped
      const sector = sectorByKey.get(clusterOf(m)) // undefined for shared → near the nucleus
      const home = (
        sector
          ? sampleCorePoint(rng, {
              dir: sector,
              dirSpread: ROLE_DIR_SPREAD,
              tMin: MAIN_ROLE_TMIN,
              tMax: MAIN_ROLE_TMAX
            })
          : sampleCorePoint(rng, { tMax: MAIN_SHARED_TMAX })
      ).multiplyScalar(S)
      const glowMat = new THREE.SpriteMaterial({
        map: glowTex,
        color: tint.glow,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const glow = new THREE.Sprite(glowMat)
      glow.userData.idx = i
      const coreMat = new THREE.MeshBasicMaterial({
        color: tint.core,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const core = new THREE.Mesh(coreGeo, coreMat)
      materials.push(glowMat, coreMat)
      scene.add(glow)
      scene.add(core)
      return {
        mem: m,
        home,
        pos: home.clone().multiplyScalar(0.3).add(randInSphere(2)), // bloom outward on open
        vel: new THREE.Vector3(),
        rpos: new THREE.Vector3(),
        baseGlow: 0.3 + 0.55 * heat,
        baseCore: 0.5 + 0.5 * heat,
        glowScale: (2.4 + 3.4 * k) * S,
        coreScale: (0.3 + 0.4 * k) * S,
        phase: Math.random() * Math.PI * 2,
        flash: 0,
        vis: 1,
        glow,
        glowMat,
        core,
        coreMat,
        neighbors: new Set<number>(),
        edges: []
      }
    })
    edges.forEach((e, i) => {
      nodes[e.a].neighbors.add(e.b)
      nodes[e.b].neighbors.add(e.a)
      nodes[e.a].edges.push(i)
      nodes[e.b].edges.push(i)
    })
    const idToIdx = new Map<string, number>(data.map((m, i) => [m.id, i]))
    const glowSprites = nodes.map((n) => n.glow) // stable hover-raycast target list
    if (!isDemo) setStats({ nodes: nodes.length, links: edges.length }) // demo counts would be fake

    // — synapse lines (one LineSegments; per-vertex color carries intensity for additive blending) —
    const ePos = new Float32Array(edges.length * 6)
    const eCol = new Float32Array(edges.length * 6)
    const eGeo = new THREE.BufferGeometry()
    eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3))
    eGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 3))
    const eMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    geometries.push(eGeo)
    materials.push(eMat)
    const lines = new THREE.LineSegments(eGeo, eMat)
    lines.frustumCulled = false // positions stream every frame; skip stale bounding-sphere culling
    scene.add(lines)

    // — pulse layers: travelling flow pulses (one Points call) + one-shot recall burst sprites —
    // Flow pulses ride both the main synapses and the background orbit-flow links: many tiny
    // signals racing around the core — the "thinking" texture. Rendered as a single Points
    // object (per-vertex position + color each frame), so the whole layer costs one draw call.
    interface FlowPulse {
      bg: boolean // riding a background link instead of a main edge
      edge: number
      rev: boolean
      t: number
      dur: number
      delay: number
    }
    const flowPulses: FlowPulse[] = []
    const respawnFlow = (p: FlowPulse): void => {
      const useBg = bgLinkCount > 0 && (edges.length === 0 || Math.random() < FLOW_BG_SHARE)
      p.bg = useBg
      p.edge = Math.floor(Math.random() * (useBg ? bgLinkCount : edges.length))
      p.rev = Math.random() < 0.5
      p.t = 0
      // background links are short — pulses zip; main edges carry slower, longer streaks
      p.dur = useBg ? 0.5 + Math.random() * 0.5 : 1.2 + Math.random()
      p.delay = Math.random() * 1.4
    }
    if (edges.length + bgLinkCount > 0) {
      for (let i = 0; i < FLOW_POOL; i++) {
        const p: FlowPulse = { bg: false, edge: 0, rev: false, t: 0, dur: 1, delay: 0 }
        respawnFlow(p)
        flowPulses.push(p)
      }
    }
    const flowPos = new Float32Array(FLOW_POOL * 3)
    const flowCol = new Float32Array(FLOW_POOL * 3)
    const flowGeo = new THREE.BufferGeometry()
    flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3))
    flowGeo.setAttribute('color', new THREE.BufferAttribute(flowCol, 3))
    flowGeo.setDrawRange(0, 0)
    const flowMat = new THREE.PointsMaterial({
      map: glowTex,
      vertexColors: true,
      size: FLOW_SIZE * S,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const flowPoints = new THREE.Points(flowGeo, flowMat)
    flowPoints.frustumCulled = false // positions stream every frame
    geometries.push(flowGeo)
    materials.push(flowMat)
    scene.add(flowPoints)

    // — background twinkles: occasionally one micro neuron briefly brightens —
    interface Twinkle {
      idx: number
      t: number
      dur: number
    }
    const twinkles: Twinkle[] = []
    const twinkling = new Set<number>()

    const makeBurst = (): BurstPulse => {
      const mat = new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xfff1dc,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
      const sprite = new THREE.Sprite(mat)
      sprite.visible = false
      sprite.raycast = () => {} // pulses must never swallow node hover hits
      materials.push(mat)
      scene.add(sprite)
      return { active: false, edge: 0, rev: false, t: 0, dur: 1, sprite, mat }
    }
    const bursts: BurstPulse[] = Array.from({ length: BURST_POOL }, makeBurst)
    const spawnBurst = (edgeIdx: number, rev: boolean): void => {
      const p = bursts.find((b) => !b.active)
      if (!p) return // pool exhausted — drop the extra sparks
      p.active = true
      p.edge = edgeIdx
      p.rev = rev
      p.t = 0
      p.dur = 0.7 + Math.random() * 0.35
      p.sprite.visible = false
    }

    // — live recall: flash the node, fire pulses down its edges —
    const unsubRecalled = window.api.onMemoryRecalled(({ ids }) => {
      for (const id of ids) {
        const idx = idToIdx.get(id)
        if (idx === undefined) continue // learned after this view loaded — ignore
        const n = nodes[idx]
        n.flash = 1
        for (const ei of samples(n.edges, BURST_EDGES_PER_NODE)) spawnBurst(ei, edges[ei].a !== idx)
      }
    })

    // — pointer: hover raycast (per frame, not per move) + click-through to the source conversation —
    const raycaster = new THREE.Raycaster()
    const mouseNdc = new THREE.Vector2()
    const lastClient = { x: 0, y: 0 }
    let pointerDirty = false
    let dragging = false
    let hoverIdx = -1
    let downX = 0
    let downY = 0
    const onPointerMove = (e: PointerEvent): void => {
      lastClient.x = e.clientX
      lastClient.y = e.clientY
      const r = canvas.getBoundingClientRect()
      mouseNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1
      mouseNdc.y = -(((e.clientY - r.top) / r.height) * 2 - 1)
      pointerDirty = true
    }
    const onPointerDown = (e: PointerEvent): void => {
      downX = e.clientX
      downY = e.clientY
    }
    const onPointerUp = (e: PointerEvent): void => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) >= 6 || hoverIdx < 0) return
      const convId = nodes[hoverIdx].mem.sourceConvId
      if (!convId) return // hand-authored memory — nowhere to jump
      window.dispatchEvent(new CustomEvent('nsai:open-conversation', { detail: { convId } }))
      onCloseRef.current()
    }
    const onPointerLeave = (): void => {
      if (hoverIdx !== -1) {
        hoverIdx = -1
        setTip(null)
        canvas.style.cursor = 'grab'
      }
    }
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerLeave)
    const onCtrlStart = (): void => {
      dragging = true
    }
    const onCtrlEnd = (): void => {
      dragging = false
      pointerDirty = true
    }
    controls.addEventListener('start', onCtrlStart)
    controls.addEventListener('end', onCtrlEnd)

    const onResize = (): void => {
      camera.aspect = W() / H()
      camera.updateProjectionMatrix()
      renderer.setSize(W(), H())
    }
    window.addEventListener('resize', onResize)

    // Keep the tooltip glued to the cursor, flipped away from the viewport edges.
    const placeTip = (): void => {
      const el = tipBoxRef.current
      if (!el) return
      const pad = 12
      let x = lastClient.x + 16
      let y = lastClient.y + 18
      if (x + el.offsetWidth + pad > window.innerWidth) x = lastClient.x - el.offsetWidth - 12
      if (y + el.offsetHeight + pad > window.innerHeight) y = lastClient.y - el.offsetHeight - 12
      el.style.left = `${Math.max(pad, x)}px`
      el.style.top = `${Math.max(pad, y)}px`
    }

    // — animation loop —
    let raf = 0
    let last = performance.now()
    let elapsed = 0
    const animate = (now: number): void => {
      raf = requestAnimationFrame(animate)
      const dt = Math.min(1 / 30, Math.max(0.001, (now - last) / 1000))
      last = now
      elapsed += dt
      const intro = Math.min(1, elapsed / 1.2) // fade the cloud in on open

      stepPhysics(nodes, edges, dt, S)

      // hover raycast against the glow sprites (generous, scale-sized hit areas);
      // demo nodes are not inspectable — hoverIdx stays -1, so no tooltip, no click-through,
      // the cursor stays "grab" and the cloud keeps auto-rotating.
      if (pointerDirty && !dragging && !isDemo) {
        pointerDirty = false
        raycaster.setFromCamera(mouseNdc, camera)
        const hits = raycaster.intersectObjects(glowSprites, false)
        const idx = hits.length ? (hits[0].object.userData.idx as number) : -1
        if (idx !== hoverIdx) {
          hoverIdx = idx
          canvas.style.cursor = idx >= 0 ? (nodes[idx].mem.sourceConvId ? 'pointer' : 'default') : 'grab'
          setTip(idx >= 0 ? { mem: nodes[idx].mem, x: lastClient.x, y: lastClient.y } : null)
        }
      }
      controls.autoRotate = hoverIdx < 0 // hold still while the user inspects a node
      if (hoverIdx >= 0) placeTip()

      // nodes: breathing drift + heat/flash/hover-driven brightness
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        n.flash = Math.max(0, n.flash - dt / FLASH_SECONDS)
        const target = hoverIdx < 0 || i === hoverIdx || nodes[hoverIdx].neighbors.has(i) ? 1 : 0.14
        n.vis += (target - n.vis) * Math.min(1, dt * 9)
        const amp = 0.22 * S // breathing amplitude follows the stage scale
        n.rpos.set(
          n.pos.x + Math.sin(elapsed * 0.5 + n.phase) * amp,
          n.pos.y + Math.sin(elapsed * 0.37 + n.phase * 1.7) * amp,
          n.pos.z + Math.sin(elapsed * 0.61 + n.phase * 0.9) * amp
        )
        const boost = (i === hoverIdx ? 1.35 : 1) * (1 + 1.7 * n.flash)
        n.glowMat.opacity = Math.min(1, n.baseGlow * n.vis * boost) * intro
        n.coreMat.opacity = Math.min(1, n.baseCore * n.vis * boost) * intro
        const gs = n.glowScale * (1 + 0.4 * n.flash) * (1 + 0.03 * Math.sin(elapsed * 0.8 + n.phase))
        n.glow.scale.set(gs, gs, 1)
        n.core.scale.setScalar(n.coreScale * (1 + 0.5 * n.flash))
        n.glow.position.copy(n.rpos)
        n.core.position.copy(n.rpos)
      }

      // synapses: track node positions; intensity = faint base, hover highlight, recall flash
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i]
        const a = nodes[e.a].rpos
        const b = nodes[e.b].rpos
        const o = i * 6
        ePos[o] = a.x
        ePos[o + 1] = a.y
        ePos[o + 2] = a.z
        ePos[o + 3] = b.x
        ePos[o + 4] = b.y
        ePos[o + 5] = b.z
        let k = 0.1
        if (hoverIdx >= 0) k = e.a === hoverIdx || e.b === hoverIdx ? 0.5 : 0.02
        k += Math.max(nodes[e.a].flash, nodes[e.b].flash) * 0.55
        k = Math.min(1, k) * intro
        eCol[o] = EDGE_R * k
        eCol[o + 1] = EDGE_G * k
        eCol[o + 2] = EDGE_B * k
        eCol[o + 3] = EDGE_R * k
        eCol[o + 4] = EDGE_G * k
        eCol[o + 5] = EDGE_B * k
      }
      eGeo.attributes.position.needsUpdate = true
      eGeo.attributes.color.needsUpdate = true

      // background layer: intro fade + random twinkles — the core quietly "thinking"
      bgMat.opacity = BG_OPACITY * intro
      blMat.opacity = BG_LINK_OPACITY * intro
      ringMat.opacity = RING_OPACITY * intro
      rayMat.opacity = RAY_OPACITY * intro
      // orbital rings: each spins very slowly about its own axis (rotation.y is the ring normal)
      for (const r of rings) r.obj.rotateY(r.speed * dt)
      // center heart: slow breathing layered on the intro fade — the brightest point on stage
      const heartBreath = 1 + 0.06 * Math.sin(elapsed * 0.9)
      heartGlow.scale.set(HEART_GLOW_SCALE * S * heartBreath, HEART_GLOW_SCALE * S * heartBreath, 1)
      heartGlowMat.opacity = HEART_GLOW_OPACITY * intro
      heartHotMat.opacity = HEART_HOT_OPACITY * (0.93 + 0.07 * Math.sin(elapsed * 1.3)) * intro
      if (twinkles.length < TWINKLE_MAX && Math.random() < dt * TWINKLE_RATE) {
        const idx = Math.floor(Math.random() * BG_COUNT)
        if (!twinkling.has(idx)) {
          twinkling.add(idx)
          twinkles.push({ idx, t: 0, dur: 0.45 + Math.random() * 0.7 })
        }
      }
      if (twinkles.length) {
        for (let i = twinkles.length - 1; i >= 0; i--) {
          const tw = twinkles[i]
          tw.t += dt / tw.dur
          const env = tw.t >= 1 ? 0 : Math.sin(Math.PI * tw.t) // 0 at the end restores the base
          const b = bgBase[tw.idx] * (1 + TWINKLE_BOOST * env)
          const o = tw.idx * 3
          bgCol[o] = BG_R * b
          bgCol[o + 1] = BG_G * b
          bgCol[o + 2] = BG_B * b
          if (tw.t >= 1) {
            twinkling.delete(tw.idx)
            twinkles.splice(i, 1)
          }
        }
        bgGeo.attributes.color.needsUpdate = true
      }

      // flow pulses: signals travelling along main edges and background links
      let flowN = 0
      for (const p of flowPulses) {
        if (p.delay > 0) {
          p.delay -= dt
          continue
        }
        p.t += dt / p.dur
        if (p.t >= 1) {
          respawnFlow(p)
          continue
        }
        const k = p.rev ? 1 - p.t : p.t
        let px: number
        let py: number
        let pz: number
        if (p.bg) {
          const o = p.edge * 6
          px = blPos[o] + (blPos[o + 3] - blPos[o]) * k
          py = blPos[o + 1] + (blPos[o + 4] - blPos[o + 1]) * k
          pz = blPos[o + 2] + (blPos[o + 5] - blPos[o + 2]) * k
        } else {
          const e = edges[p.edge]
          const fa = nodes[e.a].rpos
          const fb = nodes[e.b].rpos
          px = fa.x + (fb.x - fa.x) * k
          py = fa.y + (fb.y - fa.y) * k
          pz = fa.z + (fb.z - fa.z) * k
        }
        const o3 = flowN * 3
        flowPos[o3] = px
        flowPos[o3 + 1] = py
        flowPos[o3 + 2] = pz
        // brightness envelope baked into the vertex color (background hops stay dimmer)
        const amp = Math.sin(Math.PI * p.t) * (p.bg ? 0.5 : 1) * intro
        flowCol[o3] = amp
        flowCol[o3 + 1] = 0.78 * amp
        flowCol[o3 + 2] = 0.42 * amp
        flowN++
      }
      flowGeo.setDrawRange(0, flowN)
      flowGeo.attributes.position.needsUpdate = true
      flowGeo.attributes.color.needsUpdate = true

      // recall bursts: bright one-shot sparks down the recalled node's edges
      for (const p of bursts) {
        if (!p.active) continue
        p.t += dt / p.dur
        if (p.t >= 1) {
          p.active = false
          p.sprite.visible = false
          continue
        }
        const e = edges[p.edge]
        const from = nodes[p.rev ? e.b : e.a].rpos
        const to = nodes[p.rev ? e.a : e.b].rpos
        p.sprite.position.lerpVectors(from, to, p.t)
        p.sprite.visible = true
        const env = Math.sin(Math.PI * p.t)
        p.mat.opacity = env * 0.95 * intro
        const s = 1.5 * (0.8 + 0.5 * env) * S
        p.sprite.scale.set(s, s, 1)
      }

      controls.update()
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(raf)
      unsubRecalled()
      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      controls.removeEventListener('start', onCtrlStart)
      controls.removeEventListener('end', onCtrlEnd)
      controls.dispose()
      for (const m of materials) m.dispose()
      for (const g of geometries) g.dispose()
      glowTex.dispose()
      scene.clear()
      renderer.dispose()
      if (canvas.parentElement === container) container.removeChild(canvas)
    }
  }, [memories])

  const { EXPERT_BY_ID } = STUDIO_DATA
  const tipLayer = !tip
    ? null
    : tip.mem.layer === 'shared'
      ? 'Shared'
      : tip.mem.layer === 'collab'
        ? 'Collab'
        : (EXPERT_BY_ID[tip.mem.roleId ?? '']?.name ?? 'Role')

  return (
    <div className="mlv-overlay">
      <div ref={mountRef} className="mlv-canvas" />
      <div className="mlv-head">
        {/* Empty span still occupies the left slot so space-between keeps the close button right. */}
        <span className="mlv-stats">
          {stats ? `${stats.nodes} memories · ${stats.links} links` : null}
        </span>
        <button className="icon-btn mlv-close" onClick={onClose} title="Close (Esc)">
          <Icons.x size={16} />
        </button>
      </div>
      <div className="mlv-legend">
        <span className="mlv-leg explicit">explicit</span>
        <span className="mlv-leg user">user</span>
        <span className="mlv-leg auto">auto</span>
        <span className="mlv-leg-hint">size = tokens · brightness = recall heat · drag to orbit</span>
      </div>
      {glFailed ? (
        <div className="mlv-fail">3D view unavailable — WebGL could not start on this device.</div>
      ) : memories !== null && memories.length === 0 ? (
        // Demo cloud fills the stage; the caption sits small at the bottom center.
        <div className="mlv-empty">No memories yet — the cloud lights up as your experts learn.</div>
      ) : null}
      {tip ? (
        <div ref={tipBoxRef} className="mlv-tip" style={{ left: tip.x + 16, top: tip.y + 18 }}>
          <div className="mlv-tip-tags">
            <span className="mlv-tag">{tipLayer}</span>
            <span className="mlv-tag">{tip.mem.type}</span>
            <span className={`mlv-tag src-${tip.mem.source}`}>{tip.mem.source}</span>
          </div>
          <div className="mlv-tip-text">{tip.mem.content}</div>
          <div className="mlv-tip-meta">
            {timeAgo(tip.mem.updatedAt) ? <span>updated {timeAgo(tip.mem.updatedAt)}</span> : null}
            {timeAgo(tip.mem.lastRecalledAt) ? <span> · recalled {timeAgo(tip.mem.lastRecalledAt)}</span> : null}
          </div>
          {tip.mem.sourceConvId ? (
            <div className="mlv-tip-hint">Click to open the source conversation</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
