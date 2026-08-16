// dsh-browser driver — zero-dependency CDP browser automation for the DSH GUI.
// Node >= 22 required (global fetch + WebSocket).
//
// Protocol: JSON-lines on stdio.
//   in:  {"id":N,"cmd":"<name>","args":{...}}
//   out: {"id":N,"ok":true,"result":{...}} | {"id":N,"ok":false,"error":"..."}
// Every line is one response; stdout carries ONLY protocol lines (logs -> stderr).
//
// Commands:
//   open {url, headful?, width?, height?}   launch browser if needed, navigate, wait, screenshot, snapshot
//   snapshot {}                             {url,title,text,inputs[],clickables[]}
//   click {index?|selector?|text?}          real mouse click, wait, screenshot
//   type  {value, index?|selector?|text?, clear?}
//   press {key}                             Enter Tab Escape Backspace Delete Arrows Home End PageUp PageDown Space
//   navigate {action: back|forward|reload}
//   screenshot {}                           -> {shotRev, path, bytes}
//   eval {expression}                       -> {value}
//   wait {ms}
//   status {}                               -> {running, ready, url, title}
//   close {}                                kill browser, exit
//
// Run `node driver.mjs --selftest` for a scripted smoke test.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const WORK = process.env.DSH_BROWSER_WORK || new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SHOT_DIR = join(WORK, 'shots')
const SHOT_PATH = join(SHOT_DIR, 'current.png')

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

// ---------------------------------------------------------------- logging
const log = (...a) => { process.stderr.write('[driver] ' + a.map(String).join(' ') + '\n') }

// ------------------------------------------------------------- CDP state
let edgeChild = null
let edgePort = 0
let pageWs = null
let pageId = null
let profileDir = null
let closing = false
let shotRev = 0
let lastUrl = ''
let lastTitle = ''

let nextCdpId = 1
const cdpPending = new Map()

function cdpTimeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(true), ms))
}

function pageCdp(method, params = {}, timeoutMs = 25000) {
  if (!pageWs || pageWs.readyState !== 1) return Promise.reject(new Error('browser page not connected'))
  return new Promise((resolve, reject) => {
    const id = nextCdpId++
    cdpPending.set(id, { resolve, reject })
    pageWs.send(JSON.stringify({ id, method, params }))
    cdpTimeout(timeoutMs).then((timedOut) => {
      if (timedOut && cdpPending.delete(id)) {
        reject(new Error('CDP timeout: ' + method))
      }
    })
  })
}

function attachPageWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('failed to connect page websocket'))
  })
}

async function fetchJson(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url)
  return res.json()
}

// ------------------------------------------------------------ browser mgmt
function pickBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    if (existsSync(p)) return p
  }
  return undefined
}

function randomPort() {
  return 21000 + Math.floor(Math.random() * 27000)
}

async function pollVersion(port, attempts = 150) {
  for (let i = 0; i < attempts; i++) {
    try {
      const info = await fetchJson('http://127.0.0.1:' + port + '/json/version')
      if (info.webSocketDebuggerUrl) return info
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return undefined
}

function launchBrowser(headful, width, height) {
  const browser = pickBrowser()
  if (!browser) throw new Error('no Edge/Chrome found on this machine')
  profileDir = join(WORK, 'profile-' + Date.now().toString(36))
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(SHOT_DIR, { recursive: true })
  const port = randomPort()
  const args = [
    headful ? undefined : '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-debugging-port=' + port,
    '--remote-allow-origins=*',
    '--user-data-dir=' + profileDir,
    '--window-size=' + (width || 1280) + ',' + (height || 900),
    'about:blank',
  ].filter(Boolean)
  log('launching', browser, args.slice(0, 6).join(' '), '...')
  edgeChild = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  edgeChild.stderr.on('data', (d) => { process.stderr.write('[edge] ' + d.toString().slice(0, 400) + '\n') })
  edgeChild.on('exit', (code, signal) => {
    log('edge exited', code, signal)
    if (!closing) {
      edgeChild = null
      pageWs = null
      if (!process.exitCode) process.exit(3) // browser died under us: driver exits, host restarts
    }
  })
  edgePort = port
  return port
}

async function ensureBrowser(headful, width, height) {
  if (edgeChild && !edgeChild.killed && pageWs && pageWs.readyState === 1) return
  if (edgeChild && !edgeChild.killed) {
    // browser process alive but page socket gone — try to reconnect to the page
    try {
      const targets = await fetchJson('http://127.0.0.1:' + edgePort + '/json/list')
      const page = targets.find((t) => t.type === 'page')
      if (page) {
        pageWs = await attachPageWs(page.webSocketDebuggerUrl)
        pageId = page.id
        return
      }
    } catch { /* fall through to relaunch */ }
  }
  const port = launchBrowser(headful, width, height)
  const info = await pollVersion(port)
  if (!info) throw new Error('browser did not open its debugging endpoint')
  const page = await fetchJson('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })
  pageWs = await attachPageWs(page.webSocketDebuggerUrl)
  pageId = page.id
  pageWs.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id === undefined || !cdpPending.has(msg.id)) return
    const p = cdpPending.get(msg.id)
    cdpPending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
  }
  pageWs.onclose = () => {
    if (!closing) {
      log('page websocket closed unexpectedly')
      process.exit(3)
    }
  }
  log('browser ready on port', port, 'page', page.id)
}

function killBrowserTree() {
  if (!edgeChild) return
  const pid = edgeChild.pid
  try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best effort */ }
  try { edgeChild.kill('SIGKILL') } catch { /* best effort */ }
}

function closeBrowser() {
  closing = true
  killBrowserTree()
  edgeChild = null
  pageWs = null
  if (profileDir) {
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// ------------------------------------------------------------ page helpers
async function evalJs(expression, awaitPromise = true, timeoutMs = 15000) {
  const r = await pageCdp('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs)
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    const text = d.exception && d.exception.description ? d.exception.description : d.text
    throw new Error('page error: ' + String(text).slice(0, 300))
  }
  return r.result.value
}

// Self-contained page function: full-page DOM digest.
function pageSnapshotFn() {
  const clean = (s) => (s === undefined || s === null ? '' : String(s)).replace(/[ \t\r\n]+/g, ' ').trim().slice(0, 150)
  const SEL = 'a, button, [role="button"], input[type="button"], input[type="submit"], [onclick], select, input[type="checkbox"], input[type="radio"]'
  const clickables = Array.from(document.querySelectorAll(SEL)).map((el, i) => ({
    i,
    tag: el.tagName.toLowerCase(),
    text: clean(el.innerText || el.value || el.getAttribute('aria-label')),
    href: el.href ? String(el.href) : undefined,
    type: el.getAttribute('type') || undefined,
  }))
  const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((el, i) => ({
    i,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || undefined,
    name: el.getAttribute('name') || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    value: clean(el.value),
  }))
  return {
    url: location.href,
    title: document.title,
    text: (document.body && document.body.innerText || '').replace(/[ \t\r\n]+/g, ' ').slice(0, 6000),
    inputs,
    clickables,
  }
}

async function snapshot() {
  return evalJs('(' + pageSnapshotFn.toString() + ')()', false)
}

async function waitLoad(ms = 15000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    let ready = ''
    try { ready = await evalJs('document.readyState', false, 5000) } catch { /* navigating */ }
    if (ready === 'complete') {
      await new Promise((r) => setTimeout(r, 350))
      return 'complete'
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return 'timeout'
}

async function takeShot() {
  const r = await pageCdp('Page.captureScreenshot', { format: 'png' }, 20000)
  writeFileSync(SHOT_PATH, Buffer.from(r.data, 'base64'))
  shotRev++
  return { shotRev, path: SHOT_PATH, bytes: Math.floor(r.data.length * 3 / 4) }
}

// ------------------------------------------------------------ actions
async function click(args) {
  // Locate by selector / index / text, then click at the element center with real mouse events.
  let locateExpr = ''
  if (args.selector !== undefined && args.selector !== '') {
    locateExpr = 'document.querySelector(' + JSON.stringify(args.selector) + ')'
  } else if (args.index !== undefined) {
    locateExpr = '(function(){var SEL="a, button, [role=\\"button\\"], input[type=\\"button\\"], input[type=\\"submit\\"], [onclick], select, input[type=\\"checkbox\\"], input[type=\\"radio\\"]";var e=Array.from(document.querySelectorAll(SEL));return e[' + Number(args.index) + ']||null})()'
  } else if (args.text !== undefined && args.text !== '') {
    locateExpr = '(function(){var SEL="a, button, [role=\\"button\\"], input[type=\\"button\\"], input[type=\\"submit\\"], [onclick], select, input[type=\\"checkbox\\"], input[type=\\"radio\\"]";var needle=' + JSON.stringify(String(args.text).toLowerCase()) + ';var e=Array.from(document.querySelectorAll(SEL));for(var i=0;i<e.length;i++){var t=String(e[i].innerText||e[i].value||e[i].getAttribute("aria-label")||"").toLowerCase();if(t===needle||t.indexOf(needle)>=0)return e[i]}return null})()'
  } else {
    throw new Error('click needs one of: index, selector, text')
  }
  const meta = await evalJs('(function(){var el=' + locateExpr + ';if(!el)return null;el.scrollIntoView({block:"center",inline:"center"});var r=el.getBoundingClientRect();return {tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||"").replace(/\\s+/g," ").trim().slice(0,100),href:el.href?String(el.href):undefined,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()', false)
  if (!meta) throw new Error('target element not found')
  await pageCdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: meta.x, y: meta.y })
  await pageCdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: meta.x, y: meta.y, button: 'left', buttons: 1, clickCount: 1 })
  await new Promise((r) => setTimeout(r, 40))
  await pageCdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: meta.x, y: meta.y, button: 'left', buttons: 0, clickCount: 1 })
  return meta
}

function findInputExpr(args) {
  if (args.selector !== undefined && args.selector !== '') {
    return 'document.querySelector(' + JSON.stringify(args.selector) + ')'
  }
  if (args.index !== undefined) {
    return '(function(){var e=Array.from(document.querySelectorAll("input, textarea, select"));return e[' + Number(args.index) + ']||null})()'
  }
  if (args.text !== undefined && args.text !== '') {
    return '(function(){var needle=' + JSON.stringify(String(args.text).toLowerCase()) + ';var e=Array.from(document.querySelectorAll("input, textarea, select"));for(var i=0;i<e.length;i++){var t=String(e[i].getAttribute("placeholder")||e[i].getAttribute("name")||"").toLowerCase();if(t.indexOf(needle)>=0)return e[i]}return null})()'
  }
  return null
}

async function typeText(args) {
  const expr = findInputExpr(args)
  if (!expr) throw new Error('type needs one of: index, selector, text')
  const value = String(args.value === undefined ? '' : args.value)
  const cleared = args.clear === true
  const meta = await evalJs('(function(){var el=' + expr + ';if(!el)return null;el.scrollIntoView({block:"center"});el.focus();return {tag:el.tagName.toLowerCase(),type:el.getAttribute("type")||undefined,editable:el.isContentEditable===true||el.tagName==="INPUT"||el.tagName==="TEXTAREA"}})()', false)
  if (!meta) throw new Error('target input not found')
  if (meta.editable) {
    // Trusted-input path: what a real user does. Works with React/Vue and other
    // JS-managed inputs that ignore synthetic value setters.
    if (cleared || value === '') {
      // Ctrl+A then Delete to clear the existing content.
      await pageCdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
      await pageCdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
      await pageCdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 })
      await pageCdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 })
    }
    if (value !== '') await pageCdp('Input.insertText', { text: value })
  } else if (meta.tag === 'select') {
    // Selects cannot take text input; fall back to the native value setter.
    await evalJs('(function(){var el=' + expr + ';var setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set;setter.call(el,' + JSON.stringify(value) + ');el.dispatchEvent(new Event("change",{bubbles:true}));return el.value})()', false)
  }
  const readback = await evalJs('(function(){var el=' + expr + ';return {tag:el.tagName.toLowerCase(),type:el.getAttribute("type")||undefined,value:(el.value||el.textContent||"").slice(0,120)}})()', false)
  return readback
}

const KEY_TABLE = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
}

async function pressKey(key) {
  const k = KEY_TABLE[String(key)]
  if (!k) throw new Error('unsupported key: ' + key + ' (supported: ' + Object.keys(KEY_TABLE).join(', ') + ')')
  await pageCdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, text: k.text })
  await pageCdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk })
  return { key: k.key }
}

// ------------------------------------------------------------ command impl
const COMMANDS = {
  async status() {
    return {
      running: !!(edgeChild && !edgeChild.killed),
      ready: !!(pageWs && pageWs.readyState === 1),
      url: lastUrl,
      title: lastTitle,
      shotRev,
    }
  },

  async open(args) {
    const url = String(args.url || '')
    if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url)) {
      throw new Error('open needs an absolute http(s) URL')
    }
    await ensureBrowser(args.headful === true, args.width, args.height)
    await pageCdp('Page.navigate', { url })
    const load = await waitLoad(args.timeout || 20000)
    await takeShot()
    const snap = await snapshot()
    lastUrl = snap.url
    lastTitle = snap.title
    return { ...snap, load, shotRev }
  },

  async snapshot() {
    const snap = await snapshot()
    lastUrl = snap.url
    lastTitle = snap.title
    return snap
  },

  async click(args) {
    const meta = await click(args)
    const load = await waitLoad(8000)
    await takeShot()
    const snap = await snapshot()
    lastUrl = snap.url
    lastTitle = snap.title
    return {
      clicked: meta,
      load,
      shotRev,
      url: snap.url,
      title: snap.title,
      text: snap.text.slice(0, 1500),
      inputs: snap.inputs,
      clickables: snap.clickables,
    }
  },

  async type(args) {
    const meta = await typeText(args)
    await takeShot()
    return { typed: meta, shotRev }
  },

  async press(args) {
    const k = await pressKey(args.key)
    await takeShot()
    const snap = await snapshot()
    return { pressed: k, shotRev, url: snap.url, title: snap.title }
  },

  async navigate(args) {
    const action = String(args.action || '')
    if (action === 'back') await evalJs('history.back()')
    else if (action === 'forward') await evalJs('history.forward()')
    else if (action === 'reload') await evalJs('location.reload()')
    else throw new Error('navigate action must be back|forward|reload')
    const load = await waitLoad(15000)
    await takeShot()
    const snap = await snapshot()
    lastUrl = snap.url
    lastTitle = snap.title
    return { action, load, shotRev, url: snap.url, title: snap.title, text: snap.text.slice(0, 1500) }
  },

  async screenshot() {
    const shot = await takeShot()
    return { ...shot, view: '/dsh-browser/shot.png' }
  },

  async eval(args) {
    const raw = await evalJs(String(args.expression || ''), true, 20000)
    let value
    try {
      value = JSON.stringify(raw)
    } catch {
      value = String(raw)
    }
    if (value.length > 5000) value = value.slice(0, 5000) + '…[truncated]'
    return { value }
  },

  async wait(args) {
    const ms = Math.min(Math.max(Number(args.ms) || 0, 0), 120000)
    await new Promise((r) => setTimeout(r, ms))
    await takeShot()
    const snap = await snapshot()
    return { waited: ms, shotRev, url: snap.url, title: snap.title }
  },

  async close() {
    closeBrowser()
    return { closed: true }
  },
}

// ------------------------------------------------------------ stdio loop
let lineBuf = ''
let busy = Promise.resolve()

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function runCommand(msg) {
  const impl = COMMANDS[msg.cmd]
  if (!impl) {
    send({ id: msg.id, ok: false, error: 'unknown command: ' + msg.cmd })
    return Promise.resolve()
  }
  const timeoutMs = { open: 60000, navigate: 35000, click: 30000, type: 15000, press: 10000, snapshot: 10000, screenshot: 20000, eval: 25000, wait: 150000, status: 5000, close: 15000 }[msg.cmd] || 15000
  let done = false
  const finish = (resp) => {
    if (done) return
    done = true
    clearTimeout(timer)
    send(resp)
  }
  const timer = setTimeout(() => finish({ id: msg.id, ok: false, error: 'command timeout: ' + msg.cmd }), timeoutMs)
  return Promise.resolve()
    .then(() => impl(msg.args || {}))
    .then(
      (result) => finish({ id: msg.id, ok: true, result }),
      (err) => finish({ id: msg.id, ok: false, error: String((err && err.message) || err) }),
    )
}

const SELFTEST = process.argv[2] === '--selftest'

if (!SELFTEST) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    lineBuf += chunk
    let i
    while ((i = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, i)
      lineBuf = lineBuf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch (e) { send({ id: null, ok: false, error: 'bad request line: ' + e.message }); continue }
      busy = busy.then(() => runCommand(msg))
    }
  })
  process.stdin.on('end', () => {
    busy.then(() => {
      closing = true
      killBrowserTree()
      process.exit(0)
    })
  })
}

// ------------------------------------------------------------ selftest
async function selftest() {
  log('selftest start')
  const out = {}
  try {
    await ensureBrowser(false, 1280, 900)
    await pageCdp('Page.navigate', { url: 'https://example.com/' })
    const load = await waitLoad(20000)
    out.load = load
    const snap = await snapshot()
    out.url = snap.url
    out.title = snap.title
    out.textHead = snap.text.slice(0, 120)
    out.clickables = snap.clickables.length
    out.inputs = snap.inputs.length
    const shot = await takeShot()
    out.shotBytes = shot.bytes
    out.ok = true
  } catch (e) {
    out.ok = false
    out.error = String((e && e.message) || e)
  }
  closeBrowser()
  log('selftest done', JSON.stringify(out))
  // fs.writeSync(1) is synchronous to the pipe — process.exit() before the async
  // stdout flush would drop the line.
  const fs = await import('node:fs')
  fs.writeSync(1, 'SELFTEST ' + JSON.stringify(out) + '\n')
  process.exit(out.ok ? 0 : 1)
}

if (SELFTEST) {
  selftest()
}
