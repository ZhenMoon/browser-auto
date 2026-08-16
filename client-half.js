// browser-auto — CLIENT half of the dynamic Cordis plugin.
//
// Paste the ENTIRE content of this file into cordis_define's code.client
// (it is a plain-JS function body that returns a Cordis Plugin; no imports,
// no JSX). It renders a live panel inside the latest cordis_run card:
// browser status, current URL/title, the real-time screenshot, and quick
// actions (back / reload / screenshot / close).

const h = React.createElement

return {
  name: 'browser-auto-client',
  inject: ['timer'],
  apply(ctx) {
    styles.insert(`
.dshb-panel { border: 1px solid var(--dsh-border, #333); border-radius: 10px; padding: 10px; margin: 8px 0; background: var(--dsh-surface, rgba(128,128,128,.08)); font-size: 13px; }
.dshb-panel .dshb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshb-panel .dshb-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
.dshb-panel .dshb-dot.on { background: #4caf50; }
.dshb-panel .dshb-dot.busy { background: #ffb300; }
.dshb-panel .dshb-url { font-family: ui-monospace, monospace; font-size: 12px; opacity: .85; word-break: break-all; }
.dshb-panel .dshb-shot { width: 100%; border-radius: 8px; border: 1px solid var(--dsh-border, #333); margin-top: 8px; }
.dshb-panel .dshb-err { color: #ef5350; font-size: 12px; margin-top: 6px; white-space: pre-wrap; word-break: break-word; }
.dshb-panel .dshb-btn { background: var(--dsh-accent, rgba(100,149,237,.25)); border: 1px solid var(--dsh-border, #444); color: inherit; border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
.dshb-panel .dshb-btn:disabled { opacity: .45; cursor: default; }
.dshb-panel .dshb-empty { color: #999; font-size: 12px; margin-top: 6px; }
`)

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [rev, setRev] = React.useState(0)
      const [busy, setBusy] = React.useState(false)

      const refresh = React.useCallback(() => {
        host.call('browser-state', {}).then((s) => {
          setSt(s)
          if (s && typeof s.shotRev === 'number') setRev(s.shotRev)
        }).catch(() => {})
      }, [])

      React.useEffect(() => {
        refresh()
        const stop = ctx.interval(refresh, 2000)
        return () => stop()
      }, [refresh])

      const act = (cmd) => {
        setBusy(true)
        host.call('browser-action', { cmd }).then(() => {
          setBusy(false)
          refresh()
        }).catch(() => {
          setBusy(false)
          refresh()
        })
      }

      const running = !!(st && st.running)
      const ready = !!(st && st.ready)
      const dot = running ? (ready ? 'on' : 'busy') : ''
      const statusText = st ? (running ? (ready ? '运行中' : '启动中…') : '未运行') : '连接中…'
      const showShot = !!(st && st.shotRev > 0)

      return h('div', { className: 'dshb-panel' },
        h('div', { className: 'dshb-row' },
          h('span', { className: 'dshb-dot ' + dot }),
          h('strong', null, '浏览器 '),
          h('span', null, statusText),
          h('span', { className: 'dshb-url' }, (st && st.url) || '(无页面)'),
        ),
        h('div', { className: 'dshb-row', style: { marginTop: 6 } },
          h('button', { className: 'dshb-btn', disabled: !running || busy, onClick: () => act('back') }, '后退'),
          h('button', { className: 'dshb-btn', disabled: !running || busy, onClick: () => act('reload') }, '刷新'),
          h('button', { className: 'dshb-btn', disabled: !running || busy, onClick: () => act('screenshot') }, '截图'),
          h('button', { className: 'dshb-btn', disabled: !running || busy, onClick: () => act('close') }, '关闭'),
          h('span', { style: { color: '#888', fontSize: 11 } }, (st && st.title) || ''),
        ),
        showShot
          ? h('img', { className: 'dshb-shot', src: '/dsh-browser/shot.png?v=' + rev, alt: 'browser screenshot' })
          : h('div', { className: 'dshb-empty' }, '还没有截图 — 让我用 browser_open 打开一个网页试试'),
        (st && (st.lastError || st.driverError))
          ? h('div', { className: 'dshb-err' }, String(st.lastError || st.driverError))
          : null,
      )
    }

    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      () => h(Panel),
    ))
  },
}
