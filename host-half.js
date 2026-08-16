// dsh-browser-auto — HOST half of the dynamic Cordis plugin.
//
// Paste the ENTIRE content of this file into cordis_define's code.host
// (it is a plain-JS function body that returns a Cordis Plugin; no imports).
// Requires DSH with the dynamic-Cordis extension and a mounted subprocess
// service. See README.md for the full install walkthrough.
//
// What it does:
//   • spawns the zero-dependency CDP driver (driver.mjs) as a subprocess
//     and speaks JSON-lines over stdio,
//   • registers the browser_* model Tools via harness.defineTool/registerTool,
//   • serves the live screenshot through a webServer route
//     (/dsh-browser/shot.png, same origin as the DSH GUI),
//   • answers the Client panel's RPC (browser-state / browser-action).

// ── CONFIGURATION ─────────────────────────────────────────────────
// Absolute path to driver.mjs on YOUR machine. The dynamic host sandbox
// has no process/env access, so this must be a literal — edit it.
//   Windows: 'C:\\Users\\you\\dsh-browser-auto\\driver.mjs'
//   macOS:   '/Users/you/dsh-browser-auto/driver.mjs'
const DRIVER = 'C:\\Users\\you\\dsh-browser-auto\\driver.mjs'

// Everything else derives from the driver location: screenshots live in
// <driver dir>/shots/current.png and the driver is spawned with its own
// directory as the working directory.
const lastSep = Math.max(DRIVER.lastIndexOf('\\'), DRIVER.lastIndexOf('/'))
const SEP = DRIVER.lastIndexOf('\\') >= DRIVER.lastIndexOf('/') ? '\\' : '/'
const WORK = lastSep > 0 ? DRIVER.slice(0, lastSep) : '.'
const SHOT = WORK + SEP + 'shots' + SEP + 'current.png'
const NODE_FALLBACK = 'C:\\Program Files\\nodejs\\node.exe'

return {
  name: 'dsh-browser-auto',
  inject: ['subprocess', 'fs', 'webServer'],
  apply(ctx) {
    let handle = null
    let buf = ''
    let nextId = 1
    const pending = new Map()
    const disposers = []
    const state = { running: false, ready: false, url: '', title: '', shotRev: 0, lastError: '', driverError: '' }

    const readStderr = () => {
      try {
        const r = handle.collected.stderr.readFrom(0)
        return (r.text || '').slice(-1500)
      } catch { return '' }
    }

    function onChunk(chunk) {
      buf += chunk.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        const p = pending.get(msg.id)
        if (!p) continue
        pending.delete(msg.id)
        if (msg.ok) { p.resolve(msg.result) } else { p.reject(new Error(msg.error || 'driver error')) }
      }
    }

    async function spawnDriver() {
      if (handle) return
      let exists = false
      try { exists = !!(await ctx.fs.stat(await ctx.fs.resolve(DRIVER, {}))) } catch { exists = false }
      if (!exists) throw new Error('browser driver file missing — edit DRIVER at the top of this half: ' + DRIVER)
      let node = NODE_FALLBACK
      try { node = await ctx.subprocess.resolveExecutable('node') } catch { /* keep fallback */ }
      const h = ctx.subprocess.spawn({
        argv: [node, DRIVER],
        cwd: WORK,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
        graceMs: 3000,
      })
      handle = h
      h.stdout.on('data', onChunk)
      h.done.then((outcome) => {
        const stderr = readStderr()
        handle = null
        state.running = false
        state.ready = false
        state.driverError = 'driver exited (' + String(outcome.exitCode === null ? outcome.signal : outcome.exitCode) + '): ' + stderr.slice(-600)
        for (const p of pending.values()) p.reject(new Error(state.driverError))
        pending.clear()
      }).catch(() => {})
    }

    function call(cmd, args, timeoutMs) {
      return new Promise((resolve, reject) => {
        spawnDriver().then(() => {
          const id = nextId++
          pending.set(id, { resolve, reject })
          try {
            handle.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + '\n')
          } catch (e) {
            pending.delete(id)
            reject(e)
          }
        }).catch(reject)
      })
    }

    // The driver enforces its own per-command timeouts and always answers;
    // this wrapper only adds caller cancellation (tool abort).
    function callWithSignal(cmd, args, timeoutMs, signal) {
      return new Promise((resolve, reject) => {
        let settled = false
        const onAbort = () => {
          if (settled) return
          settled = true
          reject(new Error('browser call aborted'))
        }
        if (signal) {
          if (signal.aborted) return onAbort()
          signal.addEventListener('abort', onAbort, { once: true })
        }
        call(cmd, args, timeoutMs).then(
          (v) => { if (!settled) { settled = true; resolve(v) } },
          (e) => { if (!settled) { settled = true; reject(e) } },
        )
      })
    }

    function updateState(result) {
      if (result && typeof result === 'object') {
        if (typeof result.url === 'string') state.url = result.url
        if (typeof result.title === 'string') state.title = result.title
        if (typeof result.shotRev === 'number') state.shotRev = result.shotRev
      }
      state.lastError = ''
    }

    function defineTool(name, description, parameters, execute, timeoutMs) {
      return harness.defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        timeoutMs,
        execute,
      })
    }

    const runTool = (cmd, timeoutMs) => (args, exec) =>
      callWithSignal(cmd, args, timeoutMs, exec.signal).then((result) => {
        updateState(result)
        return result
      }, (err) => {
        state.lastError = String((err && err.message) || err)
        throw err
      })

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_open',
      '在自动化浏览器中打开一个网址（首次调用会自动启动无头 Edge/Chrome）。等待页面加载完成后自动截图，并返回页面快照（标题、正文文本、可点击元素列表、输入框列表）。',
      {
        url: { type: 'string', required: true, description: '要打开的绝对 URL，如 https://example.com' },
        headful: { type: 'boolean', description: 'true 时显示可见的浏览器窗口（默认无头）' },
        width: { type: 'integer', description: '视口宽度（默认 1280）' },
        height: { type: 'integer', description: '视口高度（默认 900）' },
        timeout: { type: 'integer', description: '页面加载等待毫秒数（默认 20000）' },
      },
      runTool('open', 90000),
      120000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_snapshot',
      '获取当前页面的结构化快照：URL、标题、正文文本、输入框（input/textarea/select）列表、可点击元素（链接/按钮等）列表，元素带索引供 click/type 使用。',
      {},
      runTool('snapshot', 15000),
      30000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_click',
      '用真实鼠标事件点击页面元素。三种定位方式任选其一：index（快照里 clickables 的索引）、selector（CSS 选择器）、text（匹配元素文本）。点击后等待可能的跳转并自动截图。',
      {
        index: { type: 'integer', description: '快照 clickables 列表中的索引' },
        selector: { type: 'string', description: 'CSS 选择器，如 #search、button.submit' },
        text: { type: 'string', description: '元素的可见文本（精确或包含匹配）' },
      },
      runTool('click', 40000),
      60000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_type',
      '向输入框输入文本（受信 CDP 输入，兼容 React/Vue 等 JS 状态输入框）。定位方式：index（快照 inputs 的索引）、selector、text（匹配 placeholder/name）。',
      {
        value: { type: 'string', required: true, description: '要输入的文本' },
        index: { type: 'integer', description: '快照 inputs 列表中的索引' },
        selector: { type: 'string', description: 'CSS 选择器' },
        text: { type: 'string', description: '匹配 placeholder 或 name 属性' },
        clear: { type: 'boolean', description: '先清空原有内容再输入（默认 false）' },
      },
      runTool('type', 20000),
      40000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_press',
      '向当前聚焦元素发送按键。支持：Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space。',
      {
        key: { type: 'string', required: true, enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'], description: '按键名称' },
      },
      runTool('press', 15000),
      30000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_navigate',
      '浏览器历史导航：back（后退）、forward（前进）、reload（刷新）。自动等待加载并截图。',
      {
        action: { type: 'string', required: true, enum: ['back', 'forward', 'reload'], description: '导航动作' },
      },
      runTool('navigate', 45000),
      60000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_screenshot',
      '立即截取当前页面截图并刷新 GUI 面板中的实时画面。返回截图信息。',
      {},
      runTool('screenshot', 25000),
      40000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_eval',
      '在页面中执行一段 JavaScript 表达式并返回结果（JSON 序列化，最长 5000 字符）。作为高级逃生舱，优先使用其它专用工具。',
      {
        expression: { type: 'string', required: true, description: '要执行的 JS 表达式，如 document.title' },
      },
      runTool('eval', 25000),
      40000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_wait',
      '等待指定毫秒数（用于 SPA 渲染/动画），等待后自动截图并返回当前页面信息。',
      {
        ms: { type: 'integer', required: true, description: '等待毫秒数（0-120000）' },
      },
      runTool('wait', 125000),
      140000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_status',
      '查询自动化浏览器状态：是否运行、当前 URL、标题、截图版本、最近错误。',
      {},
      () => ({ ...state }),
      10000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_close',
      '关闭自动化浏览器（Edge 进程树），之后再次使用 browser_open 会自动重新启动。',
      {},
      (args, exec) => callWithSignal('close', {}, 15000, exec.signal).then((r) => {
        state.running = false
        state.ready = false
        state.lastError = ''
        return r
      }, (err) => { state.lastError = String((err && err.message) || err); throw err }),
      30000,
    )))

    disposers.push(harness.registerTool(ctx, defineTool(
      'browser_launch',
      '显式启动自动化浏览器（打开 about:blank）。通常无需手动调用，browser_open 会自动启动。',
      {
        headful: { type: 'boolean', description: 'true 时显示可见窗口' },
        width: { type: 'integer', description: '视口宽度' },
        height: { type: 'integer', description: '视口高度' },
      },
      (args, exec) => callWithSignal('open', { url: 'about:blank', headful: args.headful === true, width: args.width, height: args.height }, 60000, exec.signal).then((r) => {
        updateState(r)
        return r
      }, (err) => { state.lastError = String((err && err.message) || err); throw err }),
      90000,
    )))

    // Client panel RPC
    disposers.push(harness.handle('browser-state', () => ({ ...state })))
    disposers.push(harness.handle('browser-action', async (args) => {
      const cmd = String((args && args.cmd) || '')
      const allowed = { back: 'navigate', reload: 'navigate', screenshot: 'screenshot', close: 'close', status: 'status' }
      if (!(cmd in allowed)) throw new Error('unknown panel action: ' + cmd)
      const dcmd = allowed[cmd]
      const result = await call(dcmd, dcmd === 'navigate' ? { action: cmd === 'back' ? 'back' : 'reload' } : {}, 30000)
      updateState(result)
      if (cmd === 'close') {
        state.running = false
        state.ready = false
      }
      return { ...state }
    }))

    // Live screenshot served on the DSH origin
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-browser/shot.png',
      handler: async (req, res) => {
        try {
          const target = await ctx.fs.resolve(SHOT, {})
          const info = await ctx.fs.stat(target)
          if (!info) throw new Error('no shot yet')
          const bytes = await ctx.fs.readBytes(target, undefined, 8 * 1024 * 1024)
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(bytes.byteLength) })
          res.end(bytes)
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('no screenshot yet')
        }
      },
    })

    ctx.effect(() => () => {
      disposeRoute()
      for (const d of disposers) { try { d() } catch { /* noop */ } }
      if (handle) {
        try { handle.stdin.end() } catch { /* noop */ }
        try { handle.terminate() } catch { /* noop */ }
        handle = null
      }
    }, 'dsh-browser-auto.cleanup')
  },
}
