/* OMM-ZEN UI · core/layer
 * ------------------------------------------------------------------
 * The single shared overlay surface for every OMM-ZEN floating widget:
 * dialog, select, picker, toast, menu, tooltip. One shadow root keeps
 * product CSS out; one stack makes Escape / outside-click close only the
 * top-most surface.
 *
 * Exposes: window.ZenUI.layer
 * Depends: nothing (load first)
 */
;(function (global) {
  'use strict'
  if (!global.ZenUI) global.ZenUI = {}

  var HOST_ID = 'zen-ui-layer'

  var SHADOW_CSS = [
    ':host{position:fixed;inset:0;z-index:var(--zen-z-overlay,2147483600);pointer-events:none;',
    '  --zenui-scale:var(--zen-fscale,1);',
    '  --zenui-radius:var(--zen-radius,0px);--zenui-accent:var(--accent,#000000);',
    '  --zenui-accent-soft:var(--accent-soft,rgba(0,0,0,.06));',
    '  --zenui-ink:var(--ink,#1a1a1a);--zenui-paper:var(--paper,#fff);',
    '  --zenui-soft:var(--soft,#f5f5f5);--zenui-line:var(--line,#1a1a1a);',
    '  --zenui-line-soft:var(--line-soft,rgba(26,26,26,.15));',
    '  --zenui-line-faint:var(--line-faint,rgba(26,26,26,.06));',
    '  --zenui-dim:var(--dim,rgba(26,26,26,.4));--zenui-danger:var(--danger,#b34a3c);',
    '  --zenui-shadow:var(--shadow-deep,rgba(26,26,26,.18));',
    '  font-family:"Literata","SimSun","宋体","NSimSun","Songti SC","STSong",serif;color:var(--zenui-ink)}',
    '*{box-sizing:border-box}',
    'button{font:inherit;color:inherit;border:0;background:transparent;cursor:pointer}',
    'button:focus{outline:none}',
    'button:focus-visible{outline:1px solid var(--zenui-accent);outline-offset:1px}',
    '.zenui-veil{position:fixed;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;',
    '  padding:18px;background:var(--overlay,rgba(38,35,31,.22));pointer-events:auto;',
    '  opacity:0;transition:opacity .14s ease}',
    '.zenui-veil[hidden]{display:none}',
    '.zenui-veil.on{opacity:1}',
    '.zenui-card{width:min(430px,100%);max-height:calc(100vh - 36px);display:flex;flex-direction:column;',
    '  background:var(--zenui-paper);color:var(--zenui-ink);border:1px solid var(--zenui-line);',
    '  border-radius:var(--zenui-radius);box-shadow:0 24px 70px var(--zenui-shadow);',
    '  overflow:hidden;transform:translateY(8px);transition:transform .14s ease}',
    '.zenui-veil.on .zenui-card{transform:translateY(0)}',
    '.zenui-head{display:flex;align-items:center;gap:9px;padding:10px 13px;',
    '  border-bottom:1px solid var(--zenui-line-soft);background:var(--zenui-soft)}',
    '.zenui-head::before{content:"";width:3px;height:14px;flex:0 0 auto;',
    '  background:var(--zenui-accent);border-radius:var(--zenui-radius)}',
    '.zenui-head b{font-size:calc(13px * var(--zenui-scale));letter-spacing:.05em;font-weight:600}',
    '.zenui-x{margin-left:auto;width:24px;height:24px;font-size:16px;color:var(--zenui-dim);',
    '  border-radius:var(--zenui-radius)}',
    '.zenui-x:hover{background:var(--zenui-accent-soft);color:var(--zenui-ink)}',
    '.zenui-body{padding:15px 14px;font-size:calc(11.5px * var(--zenui-scale));line-height:1.8;white-space:pre-wrap;',
    '  word-break:break-word;overflow:auto;min-height:0}',
    '.zenui-input{width:calc(100% - 28px);margin:0 14px 13px;padding:7px 9px;',
    '  border:1px solid var(--zenui-line-soft);background:var(--zenui-paper);color:var(--zenui-ink);',
    '  font:inherit;font-size:calc(11.5px * var(--zenui-scale));border-radius:var(--zenui-radius)}',
    '.zenui-input:focus{outline:none;border-color:var(--zenui-accent)}',
    '.zenui-input[hidden]{display:none}',
    '.zenui-foot{display:flex;justify-content:flex-end;gap:7px;padding:11px 14px;',
    '  border-top:1px solid var(--zenui-line-faint)}',
    '.zenui-btn{border:1px solid var(--zenui-line-soft);background:var(--zenui-paper);',
    '  color:var(--zenui-ink);font:inherit;font-size:calc(11px * var(--zenui-scale));padding:5px 14px;',
    '  border-radius:var(--zenui-radius)}',
    '.zenui-btn:hover{background:var(--zenui-soft);border-color:var(--zenui-line)}',
    '.zenui-btn.primary{background:var(--zenui-accent-soft);border-color:var(--zenui-accent);font-weight:600}',
    '.zenui-btn.danger{color:var(--zenui-danger);border-color:var(--zenui-danger)}',
    '.zenui-btn.danger:hover{background:var(--danger-soft,rgba(179,74,60,.12))}',
    '/* Popup surfaces (select / menu / picker) share one geometry vocabulary. */',
    '.zenui-menu,.zenui-popmenu{position:fixed;z-index:3;min-width:140px;max-height:min(320px,60vh);',
    '  overflow:auto;padding:3px;background:var(--zenui-paper);border:1px solid var(--zenui-line);',
    '  border-radius:var(--zenui-radius);box-shadow:0 16px 40px var(--zenui-shadow);pointer-events:auto}',
    '.zenui-menu[hidden],.zenui-popmenu[hidden]{display:none}',
    '.zenui-option{display:flex;align-items:center;width:100%;padding:6px 9px;text-align:left;',
    '  font:inherit;font-size:calc(11px * var(--zenui-scale));color:var(--zenui-ink);border-radius:var(--zenui-radius)}',
    '.zenui-option:hover,.zenui-option.active{background:var(--zenui-accent-soft)}',
    '.zenui-option[aria-selected="true"]::after{content:"✓";margin-left:auto;',
    '  color:var(--zenui-accent);font-weight:700}',
    '.zenui-option[data-danger="true"]{color:var(--zenui-danger)}',
    '.zenui-option[disabled]{opacity:.4;cursor:default}',
    '.zenui-sep{height:1px;margin:3px 4px;background:var(--zenui-line-soft)}',
    '.zenui-hint{margin-left:auto;padding-left:14px;font-size:calc(10px * var(--zenui-scale));color:var(--zenui-dim)}',
    '/* Toast stack */',
    '.zenui-toasts{position:fixed;right:16px;bottom:16px;z-index:4;display:flex;',
    '  flex-direction:column;gap:6px;align-items:flex-end;pointer-events:none;max-width:min(360px,90vw)}',
    '.zenui-toast{pointer-events:auto;padding:8px 12px;font-size:calc(11px * var(--zenui-scale));line-height:1.6;',
    '  background:var(--zenui-paper);color:var(--zenui-ink);border:1px solid var(--zenui-line);',
    '  border-left:3px solid var(--zenui-accent);border-radius:var(--zenui-radius);',
    '  box-shadow:0 8px 28px var(--zenui-shadow);animation:zenuiToastIn .16s ease}',
    '.zenui-toast[data-tone="error"]{border-left-color:var(--zenui-danger)}',
    '.zenui-toast[data-tone="success"]{border-left-color:var(--zen-green,var(--zenui-accent))}',
    '.zenui-toast[data-tone="warning"]{border-left-color:var(--zen-orange,var(--zenui-accent))}',
    '@keyframes zenuiToastIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',
    '/* Tooltip */',
    '.zenui-tip{position:fixed;z-index:5;pointer-events:none;padding:4px 7px;font-size:calc(10px * var(--zenui-scale));',
    '  background:var(--zenui-ink);color:var(--zenui-paper);border-radius:var(--zenui-radius);',
    '  box-shadow:0 4px 14px var(--zenui-shadow)}',
    '.zenui-tip[hidden]{display:none}',
    '/* Tabs / segmented control */',
    '.zenui-tabs{display:inline-flex;border:1px solid var(--zenui-line-soft);border-radius:var(--zenui-radius);',
    '  overflow:hidden;pointer-events:auto}',
    '.zenui-tab{padding:4px 12px;font-size:calc(11px * var(--zenui-scale));color:var(--zenui-dim);border-right:1px solid var(--zenui-line-soft)}',
    '.zenui-tab:last-child{border-right:0}',
    '.zenui-tab[aria-selected="true"]{background:var(--zenui-accent-soft);color:var(--zenui-ink);font-weight:600}',
    '/* Date / time picker, owned by components/picker.js. */',
    '.picker-pop{position:fixed;z-index:3;background:var(--zenui-paper);color:var(--zenui-ink);',
    '  border:1px solid var(--zenui-line);box-shadow:0 10px 30px var(--zenui-shadow);padding:10px;',
    '  min-width:var(--zenui-picker-width,238px);border-radius:var(--zenui-radius);opacity:0;',
    '  visibility:hidden;pointer-events:none;transform:translateY(-4px);',
    '  transition:opacity .16s ease,transform .16s ease,visibility .16s}',
    '.picker-pop.open{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0)}',
    '.picker-pop.pop-time{min-width:var(--zenui-picker-time-width,280px)}',
    '.pk-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:8px}',
    '.pk-head .pk-title{flex:1;text-align:center;font-size:calc(12px * var(--zenui-scale));letter-spacing:1px}',
    '.pk-nav{width:22px;height:22px;border:1px solid var(--zenui-line-soft);display:flex;',
    '  align-items:center;justify-content:center;cursor:pointer;color:var(--zenui-dim);font-size:12px;',
    '  border-radius:var(--zenui-radius);user-select:none}',
    '.pk-nav:hover{background:var(--zenui-soft);color:var(--zenui-ink);border-color:var(--zenui-line)}',
    '.pk-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}',
    '.pk-wd{font-size:calc(9px * var(--zenui-scale));color:var(--zenui-dim);text-align:center;padding:2px 0 4px}',
    '.pk-day{height:var(--zenui-picker-day,26px);display:flex;align-items:center;justify-content:center;',
    '  font-size:calc(11px * var(--zenui-scale));cursor:pointer;border:1px solid transparent;color:var(--zenui-dim);',
    '  border-radius:var(--zenui-radius)}',
    '.pk-day:hover{border-color:var(--zenui-line);color:var(--zenui-ink)}',
    '.pk-day.other{opacity:.3}',
    '.pk-day.today{border-color:var(--zenui-line-soft)}',
    '.pk-day.dis{color:var(--zenui-dim);opacity:.35;cursor:default;pointer-events:none}',
    '.pk-day.sel{background:var(--zenui-accent-soft);color:var(--zenui-ink);',
    '  border-color:var(--zenui-line);box-shadow:inset 0 -2px 0 var(--zenui-accent)}',
    '.pk-multi-foot{display:flex;gap:6px;margin-top:8px}',
    '.pk-multi-foot .pk-clear{flex:1;margin-top:0}',
    '.pk-multi-foot .pk-clear.pk-done{border-style:solid;color:var(--zenui-ink)}',
    '.pk-cols{display:flex;gap:10px;width:100%}',
    '.pk-colwrap{flex:1;min-width:0;display:flex;flex-direction:column}',
    '.pk-lab{font-size:calc(9px * var(--zenui-scale));letter-spacing:2px;text-transform:uppercase;color:var(--zenui-dim);',
    '  text-align:center;padding-bottom:6px}',
    '.pk-col{max-height:var(--zenui-picker-col,252px);overflow-y:auto;flex:1;',
    '  border:1px solid var(--zenui-line-soft);border-radius:var(--zenui-radius)}',
    '.pk-opt{display:block;width:100%;padding:8px 0;text-align:center;font:inherit;font-size:calc(12px * var(--zenui-scale));cursor:pointer;color:var(--zenui-dim)}',
    '.pk-opt:hover,.pk-opt.active{background:var(--zenui-accent-soft);color:var(--zenui-ink);font-weight:500}',
    '.pk-clear{margin-top:8px;text-align:center;font-size:calc(10px * var(--zenui-scale));letter-spacing:1px;',
    '  color:var(--zenui-dim);cursor:pointer;border:1px dashed var(--zenui-line-soft);',
    '  padding:4px;border-radius:var(--zenui-radius)}',
    '.pk-clear:hover{color:var(--zenui-ink);border-color:var(--zenui-line)}',
    ':host([data-zen-reduce-motion="true"]) *{animation:none!important;transition:none!important;scroll-behavior:auto!important}',
  ].join('')

  var DIALOG_HTML = [
    '<div class="zenui-veil" hidden>',
    '  <div class="zenui-card" role="dialog" aria-modal="true" aria-labelledby="zenui-dialog-title">',
    '    <div class="zenui-head"><b class="zenui-title" id="zenui-dialog-title">OMM-ZEN</b>',
    '      <button class="zenui-x" type="button" aria-label="关闭">×</button></div>',
    '    <div class="zenui-body"></div>',
    '    <input class="zenui-input" type="text" hidden spellcheck="false" />',
    '    <div class="zenui-foot">',
    '      <button class="zenui-btn zenui-cancel" type="button">取消</button>',
    '      <button class="zenui-btn primary zenui-ok" type="button">确定</button>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div class="zenui-menu" role="listbox" hidden></div>',
    '<div class="zenui-popmenu" role="menu" hidden></div>',
    '<div class="zenui-toasts" aria-live="polite"></div>',
    '<div class="zenui-tip" role="tooltip" hidden></div>',
  ].join('')

  var instance = null

  function syncHostState(host) {
    var root = document.documentElement
    var reduced = root && root.getAttribute('data-zen-reduce-motion') === 'true'
    if (!reduced && global.matchMedia) {
      try { reduced = global.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (e) { /* ignore */ }
    }
    host.setAttribute('data-zen-reduce-motion', reduced ? 'true' : 'false')
    host.setAttribute('data-zen-high-contrast',
      root && root.getAttribute('data-zen-high-contrast') === 'true' ? 'true' : 'false')
  }

  function get() {
    if (instance) return instance
    var host = document.createElement('div')
    host.id = HOST_ID
    host.setAttribute('data-zen-ui-layer', '1')
    var shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>' + SHADOW_CSS + '</style>' + DIALOG_HTML
    ;(document.documentElement || document.body).appendChild(host)
    syncHostState(host)
    if (typeof MutationObserver === 'function' && document.documentElement) {
      new MutationObserver(function () { syncHostState(host) }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-zen-reduce-motion', 'data-zen-high-contrast', 'style'],
      })
    }
    if (global.matchMedia) {
      try {
        global.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function () {
          syncHostState(host)
        })
      } catch (e) { /* older browsers */ }
    }

    var state = {
      host: host,
      shadow: shadow,
      veil: shadow.querySelector('.zenui-veil'),
      menu: shadow.querySelector('.zenui-menu'),
      popmenu: shadow.querySelector('.zenui-popmenu'),
      toasts: shadow.querySelector('.zenui-toasts'),
      tip: shadow.querySelector('.zenui-tip'),
      stack: [],
      closeMenu: null,
    }

    function top() {
      return state.stack.length ? state.stack[state.stack.length - 1] : null
    }

    state.push = function (entry) { state.stack.push(entry) }
    state.pop = function (entry) {
      var i = state.stack.indexOf(entry)
      if (i >= 0) state.stack.splice(i, 1)
    }
    state.top = top

    document.addEventListener('pointerdown', function (event) {
      var entry = top()
      if (entry && entry.outside) entry.outside(event)
    }, true)

    document.addEventListener('keydown', function (event) {
      var entry = top()
      if (!entry) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (entry.escape) entry.escape(event)
        return
      }
      if (entry.key) entry.key(event)
    }, true)

    instance = state
    return state
  }

  function focusables(container) {
    if (!container) return []
    var selector = 'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),' +
      'a[href],summary,[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"])'
    return Array.prototype.slice.call(container.querySelectorAll(selector)).filter(function (el) {
      return !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0
    })
  }

  function trapTab(event, container) {
    var list = focusables(container)
    if (!list.length) return
    var active = container.activeElement || document.activeElement
    var first = list[0], last = list[list.length - 1]
    if (event.shiftKey && (active === first || list.indexOf(active) < 0)) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && (active === last || list.indexOf(active) < 0)) {
      event.preventDefault(); first.focus()
    }
  }

  function restoreFocus(el) {
    if (!el || typeof el.focus !== 'function') return
    try { el.focus({ preventScroll: true }) } catch (e) { try { el.focus() } catch (ignored) { /* ignore */ } }
  }

  /* Wire a product-owned overlay (drawer / bottom sheet) into the shared stack.
   * The product keeps its markup, CSS, content and class vocabulary; only the
   * mechanism — stacked Escape / outside-click plus open/close state — is shared.
   *
   * API: ZenUI.layer.wireOverlay(opts) -> { open, close, isOpen, unbind }
   * opts: { el, mask, openClass, onOpen, onClose }
   */
  function wireOverlay(opts) {
    var o = opts || {}
    var el = o.el
    var mask = o.mask
    var cls = o.openClass || 'open'
    var entry = null
    var opener = null
    function set(on, restore) {
      if (on === !!entry) return
      if (el) el.classList.toggle(cls, on)
      if (mask) mask.classList.toggle(cls, on)
      if (on) {
        opener = document.activeElement
        entry = {
          escape: function () { set(false, true) },
          outside: function (event) {
            if (mask && event.target === mask) set(false, false)
          },
        }
        get().push(entry)
        if (o.onOpen) o.onOpen()
        var first = focusables(el)[0]
        if (first) restoreFocus(first)
      } else {
        if (entry) get().pop(entry)
        entry = null
        if (restore !== false) restoreFocus(opener)
        opener = null
        if (o.onClose) o.onClose()
      }
    }
    return {
      open: function () { set(true, true) },
      close: function () { set(false, true) },
      isOpen: function () { return !!entry },
      unbind: function () { set(false, false) },
    }
  }

  global.ZenUI.layer = {
    get: get,
    focusables: focusables,
    trapTab: trapTab,
    restoreFocus: restoreFocus,
    wireOverlay: wireOverlay,
    // True only once the layer exists and has a live surface; no initialization side effect.
    hasOpen: function () { return !!(instance && instance.stack.length) },
  }
})(window)
