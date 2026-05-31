// Mock data + exact copy — recreated from the prototype's data.jsx.
// Batch 0: this is the (mock) data source the UI renders. Later batches replace it with
// real IPC-backed services; the shapes live in '@/types'.
import type {
  Expert,
  StudioData,
  MemoryData,
  ExtensionsData,
  StudioModule,
  EndpointHealth,
  EndpointRow,
  RoleBinding,
  Greeting,
  HistoryGroup,
  Conversation,
  Project,
  ScheduledTask
} from '@/types'

const EXPERTS: Expert[] = [
  { id: 'atlas', name: 'Atlas', color: 'var(--exp-atlas)', specialty: 'Coordinator — routes & merges', personality: 'Calm air-traffic-controller', model: 'claude-haiku-4', family: 'anthropic', coordinator: true },
  { id: 'iris', name: 'Iris', color: 'var(--exp-iris)', specialty: 'Generalist — chat & brainstorming', personality: 'Warm, curious front door', model: 'gpt-5-mini', family: 'openai' },
  { id: 'hex', name: 'Hex', color: 'var(--exp-hex)', specialty: 'Software engineer — code', personality: 'Precise, direct, no pleasantries', model: 'claude-sonnet-4.6', family: 'anthropic' },
  { id: 'lyra', name: 'Lyra', color: 'var(--exp-lyra)', specialty: 'Designer — images & posters', personality: 'Creative, opinionated', model: 'imagen-4', family: 'gemini' },
  { id: 'echo', name: 'Echo', color: 'var(--exp-echo)', specialty: 'Translator — any language pair', personality: 'Precise, culturally aware', model: 'gemini-2.5-flash', family: 'gemini' },
  { id: 'sage', name: 'Sage', color: 'var(--exp-sage)', specialty: 'Editor — summarize & condense', personality: 'Structured, no padding', model: 'gemini-2.5-flash', family: 'gemini' },
  { id: 'quant', name: 'Quant', color: 'var(--exp-quant)', specialty: 'Data analyst — stats & charts', personality: 'Rigorous, honest about uncertainty', model: 'gpt-5', family: 'openai' },
  { id: 'mercury', name: 'Mercury', color: 'var(--exp-mercury)', specialty: 'Email & scheduling', personality: 'Efficient, situationally appropriate', model: 'gpt-5-mini', family: 'openai' },
  { id: 'ci', name: 'CI', color: 'oklch(0.72 0.045 235)', specialty: 'Custom — CI/CD & release assistant', personality: 'Methodical; checks the pipeline before you ask', model: null, family: null, custom: true, unconfigured: true }
]

const EXPERT_BY_ID: Record<string, Expert> = Object.fromEntries(EXPERTS.map((e) => [e.id, e]))

const USER_PROFILE = { name: 'Nico' }

const MEMORY: MemoryData = {
  selfLearning: {
    master: true,
    perExpert: { atlas: true, iris: true, hex: true, lyra: true, echo: true, sage: true, quant: true, mercury: true, ci: false }
  },
  shared: [
    { id: 's1', text: 'Goes by Nico; prefers terse, code-first answers over prose.' },
    { id: 's2', text: 'Primary stack: TypeScript, React, Python. Uses pnpm + Vite.' },
    { id: 's3', text: 'Pacific time zone; usually works mornings.' },
    { id: 's4', text: "Would rather be told they're wrong than flattered." }
  ],
  byExpert: {
    hex: {
      role: [
        { id: 'h1', text: 'Runs React 19 with StrictMode on in development.' },
        { id: 'h2', text: 'Prefers AbortController over boolean flags for effect cleanup.' },
        { id: 'h3', text: 'Reviews must include a one-line summary before the diff.' }
      ],
      collab: [{ id: 'h4', text: 'When an error is non-English, Echo translates it before Hex debugs.' }]
    },
    quant: {
      role: [
        { id: 'q1', text: 'Always wants a confidence interval, not just a point estimate.' },
        { id: 'q2', text: 'Prefers small-multiples charts over a single busy chart.' }
      ],
      collab: [{ id: 'q3', text: 'Hands finished figures to Sage to fold into summaries.' }]
    },
    echo: {
      role: [{ id: 'e1', text: 'Targets German and Japanese most often; keeps an informal register.' }],
      collab: [{ id: 'e2', text: 'Passes translated stack traces to Hex with the original kept inline.' }]
    },
    atlas: {
      role: [{ id: 'a1', text: 'Prefers a one-line synthesis at the end of multi-expert tasks.' }],
      collab: [{ id: 'a2', text: 'Routes code + non-English errors to Echo → Hex in that order.' }]
    },
    sage: { role: [{ id: 'sg1', text: 'Wants action items as bullets, max three, no preamble.' }], collab: [] },
    iris: { role: [{ id: 'i1', text: 'Likes 2–3 framed options before committing to one.' }], collab: [] },
    lyra: { role: [{ id: 'l1', text: 'Default vibe: flat, restrained, no gradients.' }], collab: [] },
    mercury: { role: [{ id: 'm1', text: 'Signs emails simply; proposes three time slots by default.' }], collab: [] },
    ci: { role: [], collab: [] }
  }
}

const EXTENSIONS: ExtensionsData = {
  mcp: [
    { name: 'GitHub', transport: 'http', endpoint: 'https://mcp.github.com/sse', status: 'connected', tools: 8, scope: 'all' },
    { name: 'Filesystem', transport: 'stdio', endpoint: 'npx @modelcontextprotocol/server-filesystem ~/projects', status: 'connected', tools: 5, scope: ['hex'] },
    { name: 'Postgres', transport: 'stdio', endpoint: 'npx mcp-server-postgres', status: 'error', tools: 0, scope: ['quant'], error: 'bad credentials' }
  ],
  skills: [
    { name: 'code-review', desc: 'Structured PR review with inline suggestions', source: 'built-in', enabled: true, scope: ['hex'] },
    { name: 'pdf', desc: 'Read & extract text and tables from PDF files', source: 'built-in', enabled: true, scope: 'all' },
    { name: 'xlsx', desc: 'Read & write spreadsheets, build formulas', source: 'built-in', enabled: true, scope: ['quant'] },
    { name: 'deep-research', desc: 'Multi-step web research with cited sources', source: 'community', enabled: false, scope: 'all' }
  ],
  plugins: [
    {
      name: 'Dev Pack',
      desc: 'Everything an engineer needs, wired up',
      source: 'community',
      enabled: true,
      bundles: [
        { type: 'skill', name: 'code-review' },
        { type: 'mcp', name: 'GitHub' },
        { type: 'role', name: 'CI' }
      ],
      summary: '1 skill · 1 MCP · 1 role'
    }
  ]
}

const STUDIO: StudioModule = {
  status: { atlas: 'routing', iris: 'idle', hex: 'working', lyra: 'idle', echo: 'working', sage: 'idle', quant: 'working', mercury: 'idle' },
  activity: { atlas: 6, iris: 3, hex: 8, lyra: 2, echo: 5, sage: 1, quant: 4, mercury: 2 },
  stats: {
    tokensToday: '48.3K',
    tokensIn: '32.1K',
    tokensOut: '16.2K',
    conversations: { inProgress: 2, done: 14, total: 16 },
    share: [
      { id: 'hex', pct: 26 }, { id: 'atlas', pct: 19 }, { id: 'echo', pct: 16 }, { id: 'quant', pct: 13 },
      { id: 'iris', pct: 10 }, { id: 'lyra', pct: 6 }, { id: 'mercury', pct: 6 }, { id: 'sage', pct: 4 }
    ]
  },
  timeline: {
    inProgress: [
      { convId: 'oauth', expert: 'hex', title: 'Fix OAuth refresh race', progress: '3 turns · 2m' },
      { convId: 'standup', expert: 'sage', title: 'Summarize standup notes', progress: 'streaming…' },
      { convId: 'churn', expert: 'quant', title: 'Q1 churn analysis', progress: '2 turns · 5m' }
    ],
    projects: [
      {
        id: 'launch',
        title: 'Q2 launch kit',
        chain: ['atlas', 'hex', 'lyra', 'quant'],
        status: '2 of 4 steps',
        steps: [
          { expert: 'atlas', role: 'Coordinating — routes & merges the work', state: 'active' },
          { expert: 'hex', role: 'Waitlist API + rate limiting', state: 'done' },
          { expert: 'lyra', role: 'Hero illustration for the page', state: 'done' },
          { expert: 'quant', role: 'Model the conversion funnel', state: 'queued' }
        ]
      }
    ]
  },
  analytics: {
    usage: {
      tokensIn: '32.1K',
      tokensOut: '16.2K',
      tokensTotal: '48.3K',
      tokensAllTime: '1.2M',
      byDay: [
        { d: 'Mon', v: 31 }, { d: 'Tue', v: 44 }, { d: 'Wed', v: 27 }, { d: 'Thu', v: 39 },
        { d: 'Fri', v: 52 }, { d: 'Sat', v: 18 }, { d: 'Sun', v: 48 }
      ],
      conversations: { inProgress: 2, done: 14, total: 16 },
      byExpert: [
        { id: 'hex', v: 12.6 }, { id: 'atlas', v: 9.2 }, { id: 'echo', v: 7.7 }, { id: 'quant', v: 6.3 },
        { id: 'iris', v: 4.8 }, { id: 'lyra', v: 2.9 }, { id: 'mercury', v: 2.9 }, { id: 'sage', v: 1.9 }
      ],
      byModel: [
        { label: 'claude-sonnet-4.6', v: 12.6, family: 'anthropic' },
        { label: 'claude-haiku-4', v: 9.2, family: 'anthropic' },
        { label: 'gemini-2.5-flash', v: 9.6, family: 'gemini' },
        { label: 'gpt-5-mini', v: 7.7, family: 'openai' },
        { label: 'gpt-5', v: 6.3, family: 'openai' },
        { label: 'imagen-4', v: 2.9, family: 'gemini' }
      ],
      byProvider: [
        { label: 'Anthropic', v: 21.8, family: 'anthropic' },
        { label: 'OpenAI', v: 14.0, family: 'openai' },
        { label: 'Gemini', v: 12.5, family: 'gemini' }
      ]
    },
    memory: {
      perExpert: [
        { id: 'hex', v: 31 }, { id: 'atlas', v: 24 }, { id: 'quant', v: 14 }, { id: 'iris', v: 12 },
        { id: 'echo', v: 9 }, { id: 'mercury', v: 8 }, { id: 'sage', v: 7 }, { id: 'lyra', v: 5 }
      ],
      total: 110,
      layers: [
        { key: 'SHARED', label: 'Shared', v: 38, hint: 'about you · all experts' },
        { key: 'ROLE', label: 'Role', v: 52, hint: 'per-expert specifics' },
        { key: 'COLLAB', label: 'Collab', v: 20, hint: 'learned across hand-offs' }
      ],
      learning: { corrected: 18, approved: 63, byWeek: [14, 19, 23, 28] }
    },
    activity: {
      byDay: [6, 9, 4, 11, 7, 3, 2, 8, 12, 5, 10, 14, 9, 16],
      mostActive: { id: 'hex', today: 8, week: 39 },
      tools: [
        { label: 'Web search', v: 47, icon: 'search' },
        { label: 'Image generation', v: 12, icon: 'image' },
        { label: 'Code execution', v: 23, icon: 'command' }
      ],
      peakHours: [0, 0, 0, 0, 0, 1, 2, 4, 7, 9, 12, 11, 8, 6, 9, 13, 10, 7, 5, 4, 3, 2, 1, 0]
    }
  }
}

const ENDPOINT_HEALTH: EndpointHealth[] = [
  { family: 'Anthropic', status: 'healthy', models: 2, checked: '30s ago' },
  { family: 'OpenAI', status: 'healthy', models: 2, checked: '30s ago' },
  { family: 'Gemini', status: 'healthy', models: 3, checked: '1m ago' }
]

// All three route through nsai (api.nicosoft.ai) — one key, three protocols, slugs per protocol.
// The real key lives in the OS keychain (Batch 2), never in source; this masked tail is display-only.
const ENDPOINTS: EndpointRow[] = [
  { name: 'Anthropic', proto: 'anthropic', status: 'healthy', models: ['nicosoft/claude-sonnet-4-6', 'nicosoft/claude-haiku-4-5-20251001'], key: '••••••8lHs', baseURL: 'https://api.nicosoft.ai' },
  { name: 'OpenAI', proto: 'openai', status: 'healthy', models: ['nicosoft/gpt-5.4-mini', 'nicosoft/gpt-5.4'], key: '••••••8lHs', baseURL: 'https://api.nicosoft.ai' },
  { name: 'Google Gemini', proto: 'gemini', status: 'healthy', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'imagen-4'], key: '••••••8lHs', baseURL: 'https://api.nicosoft.ai' }
]

const ROLE_BINDINGS: RoleBinding[] = [
  { id: 'atlas', family: 'anthropic', model: 'nicosoft/claude-haiku-4-5-20251001' },
  { id: 'iris', family: 'openai', model: 'nicosoft/gpt-5.4-mini' },
  { id: 'hex', family: 'anthropic', model: 'nicosoft/claude-sonnet-4-6' },
  { id: 'lyra', family: 'gemini', model: 'imagen-4' },
  { id: 'echo', family: 'gemini', model: 'gemini-2.5-flash' },
  { id: 'sage', family: 'gemini', model: 'gemini-2.5-flash' },
  { id: 'quant', family: 'openai', model: 'nicosoft/gpt-5.4' },
  { id: 'mercury', family: 'openai', model: 'nicosoft/gpt-5.4-mini' }
]

const GREETINGS: Record<string, Greeting> = {
  iris: { greeting: "Hi, I'm Iris. I handle the everyday stuff — ask me anything, or I'll point you to the right expert.", chips: ['Explain this error message', 'Brainstorm names for my app', 'Plan a 3-day trip'] },
  hex: { greeting: 'I write, debug, and review code. Paste a snippet or describe the bug.', chips: ['Review this function', 'Why is this test flaky?', 'Refactor for readability'] },
  atlas: { greeting: "I coordinate the team. Tell me what you need and I'll route it to the right expert — or convene several and merge their work.", chips: ['Translate and debug this error', 'Research, then summarize', 'Draft and schedule an email'] },
  lyra: { greeting: 'I make posters, illustrations, and avatars. Describe the vibe, the text, and the format.', chips: ['Poster for our game night', 'App icon, flat & minimal', 'Hero illustration, isometric'] },
  echo: { greeting: 'I translate any language pair and localize copy. Paste text and tell me the target language.', chips: ['Translate landing page to German', 'Localize for ja-JP', 'Is this idiomatic?'] },
  sage: { greeting: 'I summarize, condense, and take notes. Drop in a long doc or transcript.', chips: ['Summarize this thread', 'Turn notes into action items', 'Condense to 100 words'] },
  quant: { greeting: 'I run the numbers — stats, math, and chart recommendations. Bring your data.', chips: ['Analyze Q1 churn', 'Is this difference significant?', 'Recommend a chart'] },
  mercury: { greeting: 'I draft emails, replies, and agendas. Tell me the recipient and the gist.', chips: ['Reply to this investor', 'Draft a meeting agenda', 'Polish this cold email'] },
  ci: { greeting: "I'm CI — your release assistant. I watch builds, draft changelogs, and flag flaky pipelines. Bind me to an endpoint to get started.", chips: ['Summarize the last failed build', 'Draft release notes', 'Why is this pipeline slow?'] }
}

const HISTORY: HistoryGroup[] = [
  {
    group: 'Today',
    items: [
      { id: 'oauth', title: 'Fix OAuth refresh race', expert: 'hex' },
      { id: 'scraper', title: 'Scraper connection errors', expert: 'atlas' },
      { id: 'churn', title: 'Q1 churn analysis', expert: 'quant' },
      { id: 'standup', title: 'Summarize standup notes', expert: 'sage' },
      { id: 'debugbuild', title: 'Debug failing build', expert: 'hex' },
      { id: 'crunching', title: 'Forecast Q2 signups', expert: 'quant' }
    ]
  },
  {
    group: 'Yesterday',
    items: [
      { id: 'landing', title: 'Translate landing page', expert: 'echo' },
      { id: 'poster', title: 'Game night poster', expert: 'lyra' }
    ]
  },
  { group: 'Earlier', items: [{ id: 'investor', title: 'Reply to investor', expert: 'mercury' }] }
]

const CONVERSATIONS: Record<string, Conversation> = {
  oauth: {
    title: 'Fix OAuth refresh race',
    expert: 'hex',
    segments: [
      { who: 'user', ts: '2:13 PM', blocks: [{ type: 'para', html: 'Why does my <code class="inline">useEffect</code> run twice in React 19 dev?' }] },
      {
        who: 'hex',
        model: 'claude-sonnet-4.6',
        ts: '2:14 PM',
        blocks: [
          { type: 'para', html: "That's <strong>StrictMode</strong> intentionally double-invoking your effects in development to surface missing cleanup. It only happens in dev — production mounts once." },
          { type: 'para', html: "The fix isn't to disable StrictMode; it's to make the effect <strong>idempotent</strong>. Return a cleanup function and guard against the race:" },
          { type: 'code', lang: 'tsx', code: 'useEffect(() => {\n  const controller = new AbortController();\n  fetchUser(id, { signal: controller.signal })\n    .then(setUser)\n    .catch((e) => {\n      if (e.name !== "AbortError") throw e;\n    });\n  return () => controller.abort();   // cleanup cancels the first run\n}, [id]);' },
          { type: 'para', html: "Now the first invocation's request is aborted by its cleanup before the second fires — no duplicate state writes, no warning. The same pattern fixes your OAuth refresh: abort the in-flight token request on cleanup so two refreshes can't race." }
        ]
      }
    ]
  },
  scraper: {
    title: 'Scraper connection errors',
    expert: 'atlas',
    collab: true,
    dispatch: ['echo', 'hex'],
    segments: [
      { who: 'user', ts: '10:02 AM', blocks: [{ type: 'para', html: "Here's a stack trace from our scraper. The error is in German — translate it and tell me what's actually breaking:" }, { type: 'quote', html: 'ConnectionResetError: Verbindung vom Server zurückgesetzt' }] },
      { who: 'echo', model: 'gemini-2.5-flash', ts: '10:02 AM', blocks: [{ type: 'para', html: '<strong>Translation:</strong> "Connection reset by the server."' }, { type: 'para', html: '(German "zurückgesetzt" here = reset/dropped, not "reset to defaults".)' }] },
      { who: 'hex', model: 'claude-sonnet-4.6', ts: '10:03 AM', blocks: [{ type: 'para', html: "This isn't a bug in your code — the remote server is dropping the connection mid-request, usually rate-limiting or bot detection. Add retry-with-backoff and rotate the User-Agent:" }, { type: 'code', lang: 'python', code: 'for attempt in range(5):\n    try:\n        return session.get(url, timeout=10)\n    except ConnectionResetError:\n        time.sleep(2 ** attempt)   # 1s, 2s, 4s, 8s, 16s' }] },
      { who: 'atlas', model: 'claude-haiku-4', ts: '10:03 AM', synthesis: true, blocks: [{ type: 'para', html: 'Echo confirmed the error means the server reset the connection; Hex diagnosed it as server-side rate-limiting, not your code. <strong>Fix:</strong> wrap the request in exponential backoff (snippet above) and rotate the User-Agent. If it persists, you\'re being bot-detected — slow the crawl rate.' }] }
    ]
  },
  churn: {
    title: 'Q1 churn analysis',
    expert: 'quant',
    segments: [
      { who: 'user', ts: '9:41 AM', blocks: [{ type: 'para', html: 'Our Q1 churn went from 3.1% to 4.4% month-over-month. Is that a real trend or noise?' }] },
      { who: 'quant', model: 'gpt-5', ts: '9:42 AM', blocks: [{ type: 'para', html: 'With your cohort sizes (~2,400 accounts), a jump from 3.1% to 4.4% is <strong>statistically significant</strong> — a two-proportion z-test gives <code class="inline">p ≈ 0.018</code>, so it\'s unlikely to be noise.' }, { type: 'para', html: "That said, significance isn't causation. Before acting, I'd segment by plan tier and signup channel — aggregate churn often hides one bad cohort. <strong>Recommended chart:</strong> a small-multiples line chart, one panel per plan tier, so a single regressing segment stands out." }] }
    ]
  },
  landing: {
    title: 'Translate landing page',
    expert: 'echo',
    segments: [
      { who: 'user', ts: 'Yesterday 4:20 PM', blocks: [{ type: 'para', html: 'Translate our hero line to German: "Ship your ideas faster."' }] },
      { who: 'echo', model: 'gemini-2.5-flash', ts: 'Yesterday 4:20 PM', blocks: [{ type: 'para', html: '<strong>"Bring deine Ideen schneller auf den Markt."</strong>' }, { type: 'para', html: 'A literal "Verschicke deine Ideen" would read like shipping a parcel. This phrasing keeps the product-launch sense and uses the informal <em>du</em>, which fits a startup landing page. For a more formal B2B tone, swap to <em>Ihre Ideen</em>.' }] }
    ]
  },
  poster: {
    title: 'Game night poster',
    expert: 'lyra',
    segments: [
      { who: 'user', ts: 'Yesterday 6:05 PM', blocks: [{ type: 'para', html: 'Poster for our Friday game night — retro arcade vibe, must include the text "GAME NIGHT · FRIDAY 8PM".' }] },
      { who: 'lyra', model: 'imagen-4', ts: 'Yesterday 6:06 PM', blocks: [{ type: 'para', html: "Here's a retro-arcade take — neon on black, chunky display type." }, { type: 'imagecard' }, { type: 'para', html: 'Want a warmer palette, or tighter crop on the title?' }] }
    ]
  },
  investor: {
    title: 'Reply to investor',
    expert: 'mercury',
    segments: [
      { who: 'user', ts: 'Mon 11:30 AM', blocks: [{ type: 'para', html: 'Draft a warm but brief reply to Dana thanking her for the intro and proposing three times next week.' }] },
      { who: 'mercury', model: 'gpt-5-mini', ts: 'Mon 11:30 AM', blocks: [{ type: 'para', html: '<strong>Subject:</strong> Thanks for the intro — a few times next week' }, { type: 'para', html: "Hi Dana, thank you for connecting us — I really appreciate it. I'd love to find time next week. Would any of these work: <strong>Tue 2pm</strong>, <strong>Wed 10am</strong>, or <strong>Thu 4pm</strong> (all PT)? Happy to adjust to your calendar. Looking forward to it." }] }
    ]
  },
  standup: {
    title: 'Summarize standup notes',
    expert: 'sage',
    segments: [
      { who: 'user', ts: '9:58 AM', blocks: [{ type: 'para', html: 'Condense these standup notes into 3 bullet action items: “Auth refactor is blocked on the OAuth race — Hex is on it. Churn dashboard shipped to staging. Need a decision on the Q2 launch date by Friday.”' }] },
      { who: 'sage', model: 'gemini-2.5-flash', ts: '9:58 AM', streaming: true, blocks: [{ type: 'para', html: '<strong>Action items</strong>' }, { type: 'para', html: '• Unblock the auth refactor — Hex to land the OAuth race fix<br>• Verify the churn dashboard on staging before promoting<br>• Lock the Q2 launch da' }] }
    ]
  },
  debugbuild: {
    title: 'Debug failing build',
    expert: 'hex',
    notice: true,
    segments: [{ who: 'user', ts: '8:41 AM', blocks: [{ type: 'para', html: 'The CI build is failing on <code class="inline">tsc --noEmit</code> but it passes locally. Any idea why?' }] }]
  },
  crunching: {
    title: 'Forecast Q2 signups',
    expert: 'quant',
    loading: true,
    segments: [{ who: 'user', ts: '11:12 AM', blocks: [{ type: 'para', html: 'Given the last 6 months of signups, project Q2 and tell me the confidence interval.' }] }]
  }
}

const PROJECTS: Project[] = [
  {
    id: 'launch',
    title: 'Q2 launch kit',
    summary: 'Waitlist page, API, hero image & funnel model',
    goal: 'Ship the Q2 launch: a waitlist page with a working API, a hero illustration, and a conversion-funnel model — coordinated end to end so marketing can go live Friday.',
    phase: 'Executing',
    progress: 0.5,
    chair: 'atlas',
    experts: ['atlas', 'hex', 'lyra', 'quant'],
    plan: [
      { id: 't1', title: 'Waitlist API + rate limiting', expert: 'hex', deps: [], status: 'done', output: 'POST /waitlist live on staging · 5 req/s limit.' },
      { id: 't2', title: 'Hero illustration for the page', expert: 'lyra', deps: [], status: 'done', output: 'Delivered 3 variants · picked the isometric one.' },
      { id: 't3', title: 'Wire the page to the API', expert: 'hex', deps: ['t1', 't2'], status: 'doing', output: 'Form posts to the API; success-state copy pending.' },
      { id: 't4', title: 'Conversion-funnel model', expert: 'quant', deps: ['t1'], status: 'doing', output: 'Baseline funnel built; sensitivity analysis next.' },
      { id: 't5', title: 'QA the end-to-end flow', expert: 'hex', deps: ['t3', 't4'], status: 'todo', output: null }
    ],
    tests: [
      { id: 'v1', title: 'Form submits and persists to the database', status: 'pass' },
      { id: 'v2', title: 'Rate limit returns 429 past 5 req/s', status: 'pass' },
      { id: 'v3', title: 'Funnel projection within ±5% of last quarter', status: 'pending' },
      { id: 'v4', title: 'Hero image passes the brand checklist', status: 'pending' }
    ]
  },
  {
    id: 'onboarding',
    title: 'Onboarding revamp',
    summary: 'Rework first-run flow & welcome emails',
    goal: 'Cut first-run drop-off: simplify the setup flow and add a 3-touch welcome email sequence.',
    phase: 'Planning',
    progress: 0.12,
    chair: 'atlas',
    experts: ['atlas', 'iris', 'mercury'],
    plan: [
      { id: 'o1', title: 'Audit the current flow & drop-off points', expert: 'iris', deps: [], status: 'doing', output: 'Mapping the 4 setup steps; key drop is at endpoint.' },
      { id: 'o2', title: 'Draft the welcome email sequence', expert: 'mercury', deps: [], status: 'todo', output: null },
      { id: 'o3', title: 'Propose the simplified flow', expert: 'iris', deps: ['o1'], status: 'todo', output: null }
    ],
    tests: [{ id: 'ov1', title: 'New flow completes in under 90 seconds', status: 'pending' }]
  }
]

export const PHASES = ['Plan', 'Execute', 'Test', 'Done']
export const PHASE_INDEX: Record<string, number> = { Planning: 0, Executing: 1, Testing: 2, Done: 3 }

const SCHEDULED: ScheduledTask[] = [
  {
    id: 'weekly-report',
    name: 'Weekly report',
    trigger: { type: 'weekly', label: 'Mon 9:00' },
    enabled: true,
    nextRun: 'Mon, 9:00 AM',
    lastRun: { when: 'last Mon', result: 'ok' },
    steps: [
      { kind: 'expert', expert: 'quant', text: "Analyze last week's metrics vs. the prior week." },
      { kind: 'expert', expert: 'mercury', text: "Draft the report email from Quant's findings." },
      { kind: 'email', text: 'Send via the email MCP to the team list.' }
    ]
  },
  {
    id: 'inbox-triage',
    name: 'Daily inbox triage',
    trigger: { type: 'daily', label: 'Daily 8:00' },
    enabled: true,
    nextRun: 'Tomorrow, 8:00 AM',
    lastRun: { when: 'today', result: 'ok' },
    steps: [{ kind: 'expert', expert: 'mercury', text: 'Sort overnight email; flag anything needing a reply.' }]
  },
  {
    id: 'churn-watch',
    name: 'Churn watch',
    trigger: { type: 'weekly', label: 'Fri 17:00' },
    enabled: false,
    nextRun: '—',
    lastRun: { when: '2 weeks ago', result: 'ok' },
    steps: [
      { kind: 'expert', expert: 'quant', text: 'Compute weekly churn and compare to the 4.0% threshold.' },
      { kind: 'project', text: "If over threshold, start a 'Churn response' project." }
    ]
  }
]

export const STUDIO_DATA: StudioData = {
  EXPERTS,
  EXPERT_BY_ID,
  ENDPOINT_HEALTH,
  ENDPOINTS,
  ROLE_BINDINGS,
  GREETINGS,
  HISTORY,
  CONVERSATIONS,
  STUDIO,
  USER_PROFILE,
  EXTENSIONS,
  MEMORY,
  PROJECTS,
  SCHEDULED
}
