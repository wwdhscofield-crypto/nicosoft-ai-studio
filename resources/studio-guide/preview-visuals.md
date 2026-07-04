# Preview & Visuals

## Preview panel (⌘⇧V)

A built-in browser for the app you're building, docked in the Workspace drawer.

- When an expert starts a dev server (the `start_service` tool), the preview attaches automatically as soon as the port is ready (**Auto**). Enter a URL (e.g. `http://localhost:3000`) and Navigate to pin it manually (**Manual**).
- Toolbar: Refresh preview, Open externally, Open DevTools, Close preview.
- Network capture: requests are collected for the expert while DevTools is closed — "Network capture ready" vs "Network paused · Close DevTools to collect network requests".
- Running servers are listed under Tasks → Services with status (Starting / Running / Exited), **Stop** and **Logs**.

## Inline visuals in chat

- Experts render charts, diagrams, dashboards and small interactive widgets directly inside a reply (the `show_widget` tool). Widget cards offer Copy to clipboard, Download file, Download SVG and Download PNG.
- Georgia generates images — posters, illustrations, avatars. Results appear as a thumbnail grid; click to view or save, and iterate in place ("Refine the image above — …").
- Ask any expert with the capability for "a chart of …" — Turing's analyses typically come with charts.

## Deeper automation (Playwright)

For real browser *testing* (headless runs, request-level checks), Studio can use Playwright as a second tier. Extensions → Tools shows its status card; installing it is handled by your engineering expert on request. The Tier 1 preview above works without it.
