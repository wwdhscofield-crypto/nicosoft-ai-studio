# Block 3 — Wire the e2e Gate C verdict into UI + notifications

Closes the dogfood e2e loop (blocks 1 + 2 are committed and reused unchanged):

- **Block 1** — `e2e_browser` / `e2e_request` tools. Each action emits `sub_tool_start` /
  `sub_tool_done` via `ctx.onSubAgentToolEvent` (screenshot → `result.screenshotPath`,
  assert → `result.pass` / `result.detail`).
- **Block 2** — Gate C + `BackgroundVerifyQueue`. `runE2EVerify` runs the verifier expert
  after the turn resolves; the queue retries up to 3 rounds with an implementer fix loop and
  produces an `E2EVerdict { kind, rounds, detail, needsUser? }`.
- **Block 3 (this doc)** — surface that verdict + the live e2e run in the renderer.

> NOTE: the pipeline's backend step (Flynn) landed no code, so this block implements the thin
> backend hook as well as the frontend. Block 1/2 *core logic* is untouched — only callbacks are
> added (same pattern as `onUsage` / `onStepDone`); `webContents` never enters the service layer.

## Transport

The turn ends (`coordinator:done`) **before** Gate C runs, and the renderer deletes
`coordinatorMeta[streamId]` on done — so post-turn events on the old stream id are dropped.
Block 3 therefore uses a **dedicated set of IPC channels keyed by `convId`**, independent of the
turn stream:

| channel | DTO | when |
| --- | --- | --- |
| `verify:progress` | `VerifyProgressEvent` | each round start (`round` / `total` / `phase`) |
| `verify:tool` | `VerifyToolEvent` | every verifier e2e action (launch/click/screenshot/assert) |
| `verify:done` | `VerifyDoneEvent` | final verdict |

Screenshots travel as base64 data URLs (the app has no file protocol; `view-image` already does
this), so thumbnails render directly with `<img src=…>`.

## Backend

1. `contracts.ts` — `VerifyDoneEvent`, `VerifyToolEvent`, `VerifyProgressEvent`.
2. `coordinator.service.ts` — add `onE2EVerdict` / `onE2EToolEvent` / `onE2EProgress` to
   `CoordinatorCallbacks`.
3. `runE2EVerify` — replace the no-op `silentCb` with a forwarder that maps the verifier's
   `tool_use_start` + `sub_tool_*` events to `cb.onE2EToolEvent`, reading screenshot PNGs →
   base64. Emit `cb.onE2EProgress` at each round start. Verify/classify logic unchanged.
4. BLOCK 3 HOOK POINT (`onDone`) — build the `VerifyDoneEvent`, call `cb.onE2EVerdict`, and 回灌:
   - **PASS** → inject a next-turn context note.
   - **FAIL + needsUser** → surface to the user.
5. `coordinator.handler.ts` — route the 3 callbacks to the IPC channels above and fire an Electron
   `Notification` on PASS and on final FAIL/needsUser. `webContents` stays here.

## Frontend

6. `preload/index.ts` (+ `index.d.ts`) — `onVerifyDone` / `onVerifyTool` / `onVerifyProgress`.
7. `stores/chat.ts` — subscribe to the 3 channels; keep one synthetic
   **“Gate C — end-to-end verification”** assistant message per conversation that hosts the e2e
   timeline as a flat list of tool calls; track round `N/3`; on done stamp the verdict + fire the
   toast.
8. `stores/toast.ts` + `toaster.tsx` + `screens.css` — extend the existing toast with verdict
   variants (PASS green / FAIL red / BLOCKED yellow / SKIP gray), clickable for detail
   (round + screenshots).
9. `tool-bubble.tsx` — render e2e actions with screenshot thumbnails + assert pass/fail badge.

## Acceptance (spec 验证标准)

1. **★ the entire e2e run is visible in the ToolCard timeline** — launch / action / screenshot /
   assert verdict, item by item.
2. turn ends early (async) while Gate C keeps running in the background.
3. retry rounds show `N/3`.
4. verdict toast colored by kind, clickable for detail.
5. desktop notification on PASS and final FAIL/needsUser.
6. `npm run typecheck && npm run build` green.
