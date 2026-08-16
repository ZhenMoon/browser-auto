# dsh-browser-auto

A real-browser automation plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH), built as a dynamic Cordis plugin. It gives the agent **browser_* model tools** backed by a genuine headless Edge/Chrome instance, plus a **live screenshot panel** rendered inside the GUI.

No npm dependencies. The driver talks to the browser over the raw Chrome DevTools Protocol using Node's built-in `fetch` and `WebSocket` (Node ≥ 22).

## What it does

| Piece | Where | Role |
| --- | --- | --- |
| `driver.mjs` | spawned subprocess | Launches headless Edge/Chrome, drives it over CDP, speaks a JSON-lines protocol on stdio |
| Host half (`host-half.js`) | DSH host process | Spawns the driver, registers 12 `browser_*` model tools, serves the screenshot at `/dsh-browser/shot.png`, answers Client RPC |
| Client half (`client-half.js`) | DSH GUI page | Panel in the plugin's run card: status, URL/title, live screenshot (2 s refresh), quick-action buttons |

```
DSH agent ──browser_open/click/type…──▶ host half ──stdio JSON──▶ driver.mjs ──CDP──▶ Edge/Chrome
                                                │                        │
                                                └─ /dsh-browser/shot.png ┘
                                                │
DSH GUI ◀──browser-state/action RPC── client half (panel)
```

## Requirements

- DeepSeek Harness with the dynamic-Cordis extension (the `cordis_define` / `cordis_run` tools)
- Node.js ≥ 22 (global `fetch` + `WebSocket`)
- Microsoft Edge or Google Chrome. Windows default install paths are probed; edit `BROWSER_CANDIDATES` in `driver.mjs` for other platforms.

## Install

1. Clone / place this repo somewhere on the machine, e.g. `C:\dsh-browser-auto`.
2. In `host-half.js`, set the `DRIVER` constant to the absolute path of `driver.mjs` on your machine:

   ```js
   const DRIVER = 'C:\\dsh-browser-auto\\driver.mjs'
   ```

3. In your DSH session, define the plugin — paste the **entire content** of `host-half.js` into `code.host` and of `client-half.js` into `code.client`:

   ```
   cordis_define(plugin: { kind: "new", idPrefix: "brws" },
                 name: "dsh-browser-auto",
                 purpose: "Real browser automation: browser_* tools + live screenshot panel",
                 code: { host: <host-half.js>, client: <client-half.js> })
   ```

4. Run it and **authorize the Client half** in the GUI (single check mark on the run card):

   ```
   cordis_run(pluginId, packageId, mode: "run")
   ```

5. Smoke-test the driver standalone any time:

   ```sh
   node driver.mjs --selftest
   ```

## Tools

| Tool | What it does |
| --- | --- |
| `browser_open` | Open a URL (auto-launches the headless browser on first use), waits for load, screenshots, returns a structured page snapshot |
| `browser_snapshot` | URL, title, body text, input list, clickable-element list (indexed for click/type) |
| `browser_click` | Real mouse events at the element center; locate by snapshot index, CSS selector, or visible text |
| `browser_type` | Trusted CDP input (`Input.insertText`, Ctrl+A select-all when clearing) — works with React/Vue-managed inputs |
| `browser_press` | Keys: Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, Space |
| `browser_navigate` | History back / forward / reload |
| `browser_screenshot` | Capture now, refresh the GUI panel |
| `browser_eval` | Escape hatch: run arbitrary JS in the page, return a JSON value |
| `browser_wait` | Wait for SPA rendering/animation, then screenshot |
| `browser_status` | Running state, current URL/title, screenshot revision, last error |
| `browser_close` | Kill the browser process tree (auto-restarts on next use) |
| `browser_launch` | Explicit start (usually unnecessary; `browser_open` auto-launches) |

## Privacy & safety

- **Ephemeral profile**: every browser launch uses a fresh throwaway Edge/Chrome profile directory (`profile-<id>` beside the driver), removed when the browser closes. No cookies or history persist between sessions.
- **Everything runs locally**: pages, screenshots, and profiles stay on your machine; there is no telemetry or remote control.
- **Screenshots** are written only to `<driver dir>/shots/` and are served to the GUI over the local DSH origin. `shots/`, `profile-*`, and the runtime directory are gitignored.
- The model tools can navigate arbitrary sites and run `browser_eval` — treat this like giving the agent a real browser. Sites with bot detection (e.g. Baidu's slider CAPTCHA) may block headless browsers; that is the site's policy, not a plugin bug.

## Known limitations

- One tab, top-frame DOM only (no cross-frame automation).
- Default `BROWSER_CANDIDATES` are Windows paths; on macOS/Linux add your browser path and adjust the `--headless=new` flag if needed.
- The dynamic host sandbox has no `process`/`env`, so the driver path must be a literal in `host-half.js`.
- Node ≥ 24 (V8 13) rejects single-line `if (x) a() else b()` — keep braces or newlines in plugin code.

## License

MIT
