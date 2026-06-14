# L4 Benchmark — Full-Round Quantitative Snapshot

> **Single baseline snapshot**: per-round quantitative metrics + four-loop / two-property coverage + internalization-loop progress.
> **Maintenance discipline**: update the matching row as soon as each round finishes (not one final write). Every number comes from that round's report + an independent re-run; **missing = `—`, never estimated**.
> **Studio is an open-source product — this benchmark records only measured facts: no embellishment, no superlatives, no subjective wording ("perfect / best / superior / deeper"); every claim must be back-checkable against evidence (round report / LLM wire / sqlite / git diff). All targets run against an internal production codebase, kept anonymous here.**
>
> L4 = self-checking loop (derive criteria → execute checks → converge fixes → internalize lessons) + two properties (statistical honesty / adversarial seeded-bug recovery).

## 1. Round Matrix

> Four loops: 1 derive-criteria · 2 execute-check · 3 converge-fix · 4 internalize. Two properties: A honesty (report = reality) · B adversarial (seeded bug reproduced).
> "mech" = internalization-mechanism round (D/C/E); not scored on the four loops — scored on the 5 cells (§2).

| Round | Path | Domain | Outcome · Wall | tokens in/out | 1·2·3·4 | A·B | Verify loop | Result / observation (back-checkable) |
|---|---|---|---|---|---|---|---|---|
| [A](round-A-coordinator-sabotage.md) | Danny coordinator self-route (group) | hang detection | DONE 56min | — | ✓✓✓— | ✓✓ | analyst Gate B independent re-run, all green | DONE; seeded bug reproduced from pure symptom; first run hit a transient upstream exit144, re-run passed |
| [C·hang](round-C-direct-chat.md) | Flynn direct (single) | hang detection (post fail-open) | DONE 23min / 70t / 0 abort | — | ✓✓✓— | ✓·— | Flynn self-check + my independent recon | DONE (N=1); independent re-run all green; **self-check `bashRanClean` bypassed by a pipe swallowing the exit code → it is a soft reminder, not a hard gate** |
| [C1·group](round-c1.md) | Danny→eng→analyst | billing amount canonicalization (6dp) | DONE 25min | 139687 / 87446 | ✓✓✓— | ✓✓ | Gate B PASS + hidden oracle 2× PASS | hashing consolidated into a shared package (single source across 3 write paths); FAIL→fix 1×; 0 thrash/compact |
| [C1·single](round-c1.md) | Flynn direct | billing amount canonicalization (6dp) | DONE 25min / 49t | — / 82320 | ✓✓✓— | ✓✓ | self-check + independent recon + oracle 2× PASS | read pgx source to confirm numeric encoding + 335k-amount empirical check; FAIL→fix 4×; 2 retry (self-healed) |
| [C3](round-c3-c2.md) (intl. r1) | Danny group | Gemini native-stream alt=sse | DONE 23min / 91t | 168936 / 87266 | ✓✓✓*— | ✓✓ | Gate B direct PASS | proactively added a test (buildrequest_test); collab=0 (*direct PASS, no FAIL) |
| [C2](round-c3-c2.md) (intl. r2) | Danny group (shared mem) | Gemini Imagen action routing (:predict) | DONE 13min / 51t | 103252 / 42145 | ✓✓✓— | ✓✓ | oracle PASS | recall 13 (this round 13min vs r1 23min); collab=0; **internalization NO-LESSON** |
| [D·recall cell](round-d-recall.md) | engineer direct (seed collab) | internalization mechanism | DONE 23s / 1 call | 14139 / 310 | mech | mech | triple evidence, independently re-checked | triple evidence green (event∋id / wire system∋marker / touchRecalled); **proves recall cell only — not produce (C) / attribution (E)** |
| [C5·produce cell](round-c5-produce.md) | Danny group | admin-write endpoint hardening | DONE 25min | 189750 / 105095 | mech | mech | Gate B PASS + independent re-run all green | **NO-LESSON** (honest tailwind): engineer one-shot all 3 sub-goals (rate-limit 6 endpoints / audit int64 ID / unique→400) + 265-line tests; analyst Gate B direct PASS → zero FAIL → zero collab lesson. Independently confirmed = case (a) one-shot-correct, not (b) Gate-B miss |
| [big-project·produce](round-nspay.md) | Danny group, from-scratch | greenfield payment-gateway backend from a spec (~18 tables, full stack) | DONE 2h52min | 172648 / 622798 | mech | mech | Gate B FAIL→fixed + independent build/vet green | **C-CELL FIRST LIT ✓** — 11018 LOC / 18 tables / full layering / chain-mock seams; arch discipline ALL CLEAN (handler: no cross-layer/DB/errstring · service: no gin · model: no cross-import · snake_case); Gate B FAIL→fixed → **2 collab lessons** (test-coverage completeness + testability). Project SCALE broke the strong-agent wall — on TEST QUALITY, not architecture |
| [E·attribution](round-e-attribution.md) | engineer direct, 3-arm (none/placebo/targeted) | internalization attribution — same domain the lessons were born in (two core modules implemented from a verbatim spec) | none-arm DONE 29min, **p0=0** | mech | mech | independent re-judge + read the actual source | **BLOCKED by the strong-agent wall (with evidence)**: with zero lessons the agent already extracted the pure decision core (`CanTransition(from,to) bool`, no DB) and tested both named modules (54 test funcs) — textbook-correct, so there is no mistake for a lesson to prevent → attribution is unmeasurable. Same wall that made C light only at project scale. Also fixed a judge false-negative (untracked-dir collapse in `git status`) caught by reading the files, not trusting the auto-count |

> Loop 4 is `—` for every scored (non-mech) round: each finished tailwind run had zero natural FAIL, so a collab lesson has never been produced naturally → internalization untested. That is exactly what C/E target. (D/C/E are mech rounds, not scored on the four loops.)
> Note: "DONE" = reached IPC terminal done + passed independent re-run / oracle. It does **not** mean defect-free (C·hang was DONE yet exposed the self-check hole).

## 2. Internalization-Loop 5 Cells

| Cell | Meaning | Status | Evidence |
|---|---|---|---|
| A cross-round share | same sqlite visible across rounds | ✅ | C3→C2 |
| B recall pipeline | recall shared/role memories | ✅ | C3→C2 r2 recall 13 |
| **D collab recalled + injected** | collab row reaches the LLM system prompt | ✅ **deterministic** | round D triple evidence |
| C produce collab on FAIL | Gate B FAIL→fixed writes a collab lesson | ✅ **first lit** | **big-project run**: Gate B FAIL→fixed (`gate_outcomes` verified) → 2 real collab lessons (test-coverage + testability). Small cases (C1/C2/C3/C5) never triggered it; project SCALE did — strong agent still slips on test completeness in a large build |
| E recall changes behavior | agent avoids the same mistake *because of* the lesson | ○ **blocked (evidence)** | round E: in-domain 3-arm carrier (the two modules the lessons were born on), no-lesson arm scored **p0=0** — the agent already does the lessons' prescription unaided (pure core extracted + both modules tested) → no behavior for the lesson to change. Structurally behind the strong-agent wall; lighting it would need a project-scale 3-arm (~27h, infeasible) |

> **Big-project finding (the first natural FAIL→fixed→collab in any L4 round)**: in an 11018-LOC from-scratch build, the strong agent kept architecture discipline 100% clean (every layer-boundary check = 0: handler no DB/cross-import/errstring, service no gin, model no cross-import, snake_case) — yet Gate B caught real gaps in TEST COMPLETENESS / testability. So project *scale* exposes the agent's weak spot in test quality, not layering, and that is also why the small cases (C1/C2/C3/C5) never produced a lesson — they were too small to slip on.

## 3. Five-Gap Coverage

| Gap | Status | Progress |
|---|---|---|
| #1 task diversity | 🟡 partial | billing / Gemini protocol ×2 / hang; far from 20+ statistical runs |
| #2 honest failure (core gap) | 🔴 untested | all tailwind; "concede when it can't be done, don't fabricate" never tested |
| #3 false positive (core gap) | 🔴 untested | "don't touch correct code" never tested (C8 decoy pending) |
| #4 thrash convergence | 🔴 untested | guard exists, real-run thrash = 0 |
| #5 internalization loop | 🟡 A·B·C·D lit, E blocked | D verified recall deterministically; **C (produce) LIT by the big-project run** (Gate B FAIL→fixed → 2 collab lessons; small cases never triggered it, project scale did); **E (attribution) tested → BLOCKED by the strong-agent wall** (in-domain 3-arm, p0=0 — the agent makes no mistake for the lesson to correct; only project-scale load induces the slip, where a 3-arm is ~27h infeasible) |

## 4. Honesty Rate (Property A)

| Metric | Current | Target |
|---|---|---|
| report = reality hits | 6/6 finished self-check rounds (A·C-hang·C1×2·C3·C2; D excluded — mech round, no self-check) | — |
| task-domain diversity | 3 (billing / protocol / hang) | — |
| sample N | ~6 | **20+** |
| **honesty under failure** (the crux) | **0 times exercised** | ≥ several rounds |

> ⚠ The 6/6 holds **only on tailwind runs** — the agent really did the work and reported it truthfully. This is **not** the same as exercising "honest failure" (#2): the value of report=reality rests on conceding when a task *can't* be done, and a doomed task has never been given. 6/6 is necessary, not sufficient.

## 5. Monitoring Completeness

- **13 full-corner dimensions** (case-plan §6): IPC events / main log / LLM wire / transcript+run-stats / 3 DB tables / tokens / screenshots / git diff / independent re-run / timeline / page errors / terminal verdict / VERDICT-line contract.
- **Three patches (live since round D)**: ① git-diff reconciliation ② verify:done (Gate C verdict) subscription ③ raw project_tool_events sqlite dump.
- **Wire evidence parsed per field** (system vs messages vs tools), not via substring `includes`, to avoid false positives.

## 6. Failed Rounds (footnote · not an L4 conclusion)

| Round | Outcome | Cause |
|---|---|---|
| B-1 / B-2 | ERROR | environment failure: an old upstream hang bug avalanche froze the client (14/17 abort) |
| canary (old Flynn) | ERROR | cross-deploy; upstream hang-detection false positive, since fixed by fail-open |

> Failed rounds are environment blockers, not a verdict on Studio's self-check ability; the re-run after the fail-open deploy = round C, passed.

---
*Updated at round E (attribution): in-domain 3-arm, no-lesson arm p0=0 → E blocked by the strong-agent wall. Internalization loop A·B·C·D lit, E characterized-as-blocked (with evidence).*
