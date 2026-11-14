/*
 * OMM-ZEN desktop bridge
 * ======================
 * One script is shared by every product page and by the hub shell:
 *
 *   product page   intercepts downloads, saves documents, owns its own state
 *   hub shell      renders the archive panel for the product in the focused tab
 *   embedded page  answers archive requests that the hub forwards to it
 *
 * The file is organised in layers, top to bottom:
 *
 *   ui       archive panel, tabs, rows, details (rendered from `model`)
 *   archive  scoped queries against /__omm/fs/archive
 *   config   per-product save settings
 *   capture  localStorage / sessionStorage / IndexedDB <-> JSON
 *   api      typed helpers for /__omm/fs/*
 *   bridge   hub <-> product postMessage protocol
 *
 * Rule of ownership: application state can only be captured or restored by the
 * document that owns the origin.  The hub therefore *asks* a product to take a
 * snapshot instead of reading the iframe from outside.
 */

/* ====================================================================== *
 * OMM-ZEN UI kit
 * --------------
 * Everything that used to be a browser-native popup is rendered here instead:
 * confirm / alert / prompt dialogs, select candidate lists and title
 * tooltips.  The surfaces live in a shadow root so product CSS cannot leak
 * in, and they inherit the shell's --radius / --accent / --ink variables so
 * they always follow the current OMM-ZEN appearance.
 *
 * Exposed as window.OMMUI and loaded first, so omm-share.js and omm-hub.js
 * can use it too.
 * ====================================================================== */
;(function () {
  'use strict';
  if (window.OMMUI) return;

  var HOST_ID = 'omm-ui-host';
  var LIGHT_STYLE_ID = 'omm-ui-light-style';
  var host = null, shadow = null;
  var veil = null, headTitle = null, bodyEl = null, inputEl = null;
  var cancelBtn = null, okBtn = null, closeBtn = null, menu = null, tip = null;
  var pending = null;        /* { resolve, kind, danger } */
  var activeSelect = null;   /* { select, trigger, sync, index } */
  var tipTarget = null, tipTimer = 0;

  var SHADOW_CSS = [
    ':host{position:fixed;inset:0;z-index:2147483600;pointer-events:none;',
    '  --oui-radius:var(--radius,0px);--oui-accent:var(--accent,#e3a400);',
    '  --oui-accent-soft:var(--accent-soft,rgba(227,164,0,.16));',
    '  --oui-ink:var(--ink,#26231f);--oui-paper:var(--paper,#fff);',
    '  --oui-soft:var(--soft,#f7f5ef);--oui-line:var(--line,#26231f);',
    '  --oui-line-soft:var(--line-soft,rgba(38,35,31,.16));',
    '  --oui-line-faint:var(--line-faint,rgba(38,35,31,.07));',
    '  --oui-dim:var(--dim,rgba(38,35,31,.48));--oui-danger:var(--danger,#b34a3c);',
    '  --oui-shadow:var(--shadow-deep,rgba(38,35,31,.24));',
    '  font-family:"Literata","Songti SC","SimSun",serif;color:var(--oui-ink)}',
    '*{box-sizing:border-box}',
    'button{font:inherit;color:inherit;border:0;background:transparent;cursor:pointer}',
    'button:focus{outline:none}',
    'button:focus-visible{outline:1px solid var(--oui-accent);outline-offset:1px}',
    '.oui-veil{position:fixed;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;',
    '  padding:18px;background:var(--overlay,rgba(38,35,31,.22));pointer-events:auto;',
    '  opacity:0;transition:opacity .14s ease}',
    '.oui-veil[hidden]{display:none}',
    '.oui-veil.on{opacity:1}',
    '.oui-card{width:min(430px,100%);max-height:calc(100vh - 36px);display:flex;flex-direction:column;',
    '  background:var(--oui-paper);color:var(--oui-ink);border:1px solid var(--oui-line);',
    '  border-radius:var(--oui-radius);box-shadow:0 24px 70px var(--oui-shadow);',
    '  overflow:hidden;transform:translateY(8px);transition:transform .14s ease}',
    '.oui-veil.on .oui-card{transform:translateY(0)}',
    '.oui-head{display:flex;align-items:center;gap:9px;padding:10px 13px;',
    '  border-bottom:1px solid var(--oui-line-soft);background:var(--oui-soft)}',
    '.oui-head::before{content:"";width:3px;height:14px;flex:0 0 auto;',
    '  background:var(--oui-accent);border-radius:var(--oui-radius)}',
    '.oui-head b{font-size:13px;letter-spacing:.05em;font-weight:600}',
    '.oui-x{margin-left:auto;width:24px;height:24px;font-size:16px;color:var(--oui-dim);',
    '  border-radius:var(--oui-radius)}',
    '.oui-x:hover{background:var(--oui-accent-soft);color:var(--oui-ink)}',
    '.oui-body{padding:15px 14px;font-size:11.5px;line-height:1.8;white-space:pre-wrap;',
    '  word-break:break-word;overflow:auto;min-height:0}',
    '.oui-input{width:calc(100% - 28px);margin:0 14px 13px;padding:7px 9px;',
    '  border:1px solid var(--oui-line-soft);background:var(--oui-paper);color:var(--oui-ink);',
    '  font:inherit;font-size:11.5px;border-radius:var(--oui-radius)}',
    '.oui-input:focus{outline:none;border-color:var(--oui-accent)}',
    '.oui-input[hidden]{display:none}',
    '.oui-foot{display:flex;justify-content:flex-end;gap:7px;padding:11px 14px;',
    '  border-top:1px solid var(--oui-line-faint)}',
    '.oui-btn{border:1px solid var(--oui-line-soft);background:var(--oui-paper);',
    '  color:var(--oui-ink);font:inherit;font-size:11px;padding:5px 14px;',
    '  border-radius:var(--oui-radius)}',
    '.oui-btn:hover{background:var(--oui-soft);border-color:var(--oui-line)}',
    '.oui-btn.primary{background:var(--oui-accent-soft);border-color:var(--oui-accent);font-weight:600}',
    '.oui-btn.danger{color:var(--oui-danger);border-color:var(--oui-danger)}',
    '.oui-btn.danger:hover{background:var(--danger-soft,rgba(179,74,60,.12))}',
    '.oui-menu{position:fixed;z-index:3;min-width:140px;max-height:min(320px,60vh);overflow:auto;',
    '  padding:3px;background:var(--oui-paper);border:1px solid var(--oui-line);',
    '  border-radius:var(--oui-radius);box-shadow:0 16px 40px var(--oui-shadow);',
    '  pointer-events:auto}',
    '.oui-menu[hidden]{display:none}',
    '.oui-option{display:flex;align-items:center;width:100%;padding:6px 9px;text-align:left;',
    '  font:inherit;font-size:11px;color:var(--oui-ink);border-radius:var(--oui-radius)}',
    '.oui-option:hover,.oui-option.active{background:var(--oui-accent-soft)}',
    '.oui-option[aria-selected="true"]::after{content:"✓";margin-left:auto;',
    '  color:var(--oui-accent);font-weight:700}',
    '.oui-tip{position:fixed;z-index:4;max-width:260px;padding:5px 9px;',
    '  font-size:10px;line-height:1.55;white-space:pre-wrap;word-break:break-word;',
    '  background:var(--oui-paper);color:var(--oui-ink);border:1px solid var(--oui-line);',
    '  border-radius:var(--oui-radius);box-shadow:0 8px 22px var(--oui-shadow);',
    '  pointer-events:none}',
    '.oui-tip[hidden]{display:none}'
  ].join('');

  /* Styles for the light-DOM trigger of custom selects.  Kept in the page so
     the wrapper inherits the surrounding font/label layout. */
  var LIGHT_CSS = [
    '.oui-select{display:inline-flex;align-items:center;min-width:0;vertical-align:middle}',
    'button.oui-select-trigger{display:flex;align-items:center;justify-content:space-between;',
    '  gap:10px;min-width:104px;padding:4px 8px;',
    '  border:1px solid var(--line-soft,rgba(38,35,31,.16));',
    '  background:var(--paper,#fff);color:var(--ink,#26231f);',
    '  font-family:inherit;font-size:10.5px;line-height:1.5;cursor:pointer;',
    '  border-radius:var(--radius,0px);white-space:nowrap}',
    'button.oui-select-trigger::after{content:"▾";color:var(--dim,rgba(38,35,31,.48));font-size:9px}',
    'button.oui-select-trigger:hover{border-color:var(--accent,#e3a400)}',
    'button.oui-select-trigger[aria-expanded="true"]{border-color:var(--accent,#e3a400);',
    '  background:var(--accent-soft,rgba(227,164,0,.16))}',
    'button.oui-select-trigger:focus{outline:none}',
    'button.oui-select-trigger:focus-visible{outline:1px solid var(--accent,#e3a400);outline-offset:1px}',
    'select[data-omm-select]{display:none!important}',
    'button:focus:not(:focus-visible),[role="button"]:focus:not(:focus-visible){outline:none}'
  ].join('');

  var DIALOG_HTML = [
    '<div class="oui-veil" hidden>',
    '  <div class="oui-card" role="dialog" aria-modal="true">',
    '    <div class="oui-head"><b class="oui-title">OMM-ZEN</b>',
    '      <button class="oui-x" type="button" aria-label="关闭">×</button></div>',
    '    <div class="oui-body"></div>',
    '    <input class="oui-input" type="text" hidden spellcheck="false" />',
    '    <div class="oui-foot">',
    '      <button class="oui-btn oui-cancel" type="button">取消</button>',
    '      <button class="oui-btn primary oui-ok" type="button">确定</button>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div class="oui-menu" role="listbox" hidden></div>',
    '<div class="oui-tip" hidden></div>'
  ].join('');

  function ensure() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-omm-ui-layer', '1');
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + SHADOW_CSS + '</style>' + DIALOG_HTML;
    (document.documentElement || document.body).appendChild(host);
    veil = shadow.querySelector('.oui-veil');
    headTitle = shadow.querySelector('.oui-title');
    bodyEl = shadow.querySelector('.oui-body');
    inputEl = shadow.querySelector('.oui-input');
    cancelBtn = shadow.querySelector('.oui-cancel');
    okBtn = shadow.querySelector('.oui-ok');
    closeBtn = shadow.querySelector('.oui-x');
    menu = shadow.querySelector('.oui-menu');
    tip = shadow.querySelector('.oui-tip');

    if (!document.getElementById(LIGHT_STYLE_ID)) {
      var style = document.createElement('style');
      style.id = LIGHT_STYLE_ID;
      style.textContent = LIGHT_CSS;
      document.head.appendChild(style);
    }

    veil.addEventListener('click', function (event) {
      if (event.target === veil) finish(false);
    });
    cancelBtn.addEventListener('click', function () { finish(false); });
    closeBtn.addEventListener('click', function () { finish(false); });
    okBtn.addEventListener('click', function () { finish(true); });
    inputEl.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    });
    menu.addEventListener('click', function (event) {
      var option = event.target.closest('.oui-option');
      if (!option) return;
      chooseOption(Number(option.dataset.index));
    });
    menu.addEventListener('pointerover', function (event) {
      var option = event.target.closest('.oui-option');
      if (!option || !activeSelect) return;
      activeSelect.index = Number(option.dataset.index);
      paintMenu();
    });
  }

  function blurAll() {
    try { if (shadow && shadow.activeElement && shadow.activeElement.blur) shadow.activeElement.blur(); } catch (e) { /* ignore */ }
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { /* ignore */ }
  }

  function normalizeOptions(opts) {
    var out = typeof opts === 'string' ? { title: opts } : (opts || {});
    return {
      title: out.title || 'OMM-ZEN',
      ok: out.ok || '确定',
      cancel: out.cancel || '取消',
      danger: !!out.danger,
      kind: out.kind || 'confirm',
      value: out.value == null ? '' : String(out.value)
    };
  }

  function openDialog(message, opts) {
    ensure();
    var o = normalizeOptions(opts);
    if (pending) finish(false);
    closeMenu();
    hideTip(true);
    return new Promise(function (resolve) {
      pending = { resolve: resolve, kind: o.kind, danger: o.danger };
      headTitle.textContent = o.title;
      bodyEl.textContent = String(message == null ? '' : message);
      cancelBtn.textContent = o.cancel;
      cancelBtn.hidden = o.kind === 'alert';
      okBtn.textContent = o.ok;
      okBtn.classList.toggle('danger', o.danger);
      okBtn.classList.toggle('primary', !o.danger);
      inputEl.hidden = o.kind !== 'prompt';
      inputEl.value = o.value;
      veil.hidden = false;
      /* Do not leave a focus ring behind once the choice has been made. */
      window.requestAnimationFrame(function () {
        veil.classList.add('on');
        var focusTarget = o.kind === 'prompt' ? inputEl : okBtn;
        try { focusTarget.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        if (o.kind === 'prompt' && inputEl.select) inputEl.select();
      });
    });
  }

  function finish(confirmed) {
    if (!pending) return;
    var job = pending;
    pending = null;
    var value = null;
    if (job.kind === 'prompt') value = confirmed ? inputEl.value : null;
    else if (job.kind === 'alert') value = true;
    else value = !!confirmed;
    veil.classList.remove('on');
    veil.hidden = true;
    blurAll();
    job.resolve(value);
  }

  function confirm(message, opts) { return openDialog(message, opts); }
  function alertBox(message, opts) {
    var o = normalizeOptions(opts);
    o.kind = 'alert';
    return openDialog(message, o);
  }
  function promptBox(message, value, opts) {
    var o = normalizeOptions(opts);
    o.kind = 'prompt';
    o.value = value;
    return openDialog(message, o);
  }

  /* -------------------------------------------------------- custom selects */

  function currentLabel(select) {
    var opt = select.options[select.selectedIndex];
    return opt ? opt.textContent : '';
  }

  function paintMenu() {
    if (!activeSelect) return;
    var options = menu.querySelectorAll('.oui-option');
    Array.prototype.forEach.call(options, function (el, i) {
      el.classList.toggle('active', i === activeSelect.index);
    });
    var active = options[activeSelect.index];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function positionMenu() {
    if (!activeSelect) return;
    var rect = activeSelect.trigger.getBoundingClientRect();
    var width = Math.max(rect.width, 140);
    var height = Math.min(menu.scrollHeight || 200, 320);
    var top = rect.bottom + 3;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 3);
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
    menu.style.top = top + 'px';
    menu.style.minWidth = width + 'px';
  }

  function openMenu(select, trigger, sync) {
    ensure();
    if (activeSelect && activeSelect.select === select) { closeMenu(); return; }
    closeMenu();
    var html = '';
    Array.prototype.forEach.call(select.options, function (opt, i) {
      html += '<button class="oui-option" type="button" role="option" data-index="' + i +
        '" aria-selected="' + (opt.value === select.value ? 'true' : 'false') + '">' +
        String(opt.textContent || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '</button>';
    });
    menu.innerHTML = html || '<button class="oui-option" type="button" disabled>无选项</button>';
    activeSelect = {
      select: select, trigger: trigger, sync: sync,
      index: Math.max(0, select.selectedIndex)
    };
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    positionMenu();
    paintMenu();
  }

  function closeMenu() {
    if (!activeSelect) return;
    try { activeSelect.trigger.setAttribute('aria-expanded', 'false'); } catch (e) { /* ignore */ }
    activeSelect = null;
    if (menu) menu.hidden = true;
    blurAll();
  }

  function chooseOption(index) {
    if (!activeSelect) return;
    var select = activeSelect.select;
    var sync = activeSelect.sync;
    var opt = select.options[index];
    if (!opt || opt.disabled) return;
    select.value = opt.value;
    try { select.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* ignore */ }
    if (sync) sync();
    closeMenu();
    /* A choice must never leave the control in a focused / selected state. */
    window.setTimeout(blurAll, 0);
  }

  function enhanceSelect(root) {
    ensure();
    var scope = root || document;
    var list = scope.querySelectorAll('select[data-omm-select]');
    Array.prototype.forEach.call(list, function (select) {
      if (select.dataset.ommEnhanced === '1') return;
      select.dataset.ommEnhanced = '1';
      var wrap = document.createElement('span');
      wrap.className = 'oui-select';
      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'oui-select-trigger';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      var label = document.createElement('span');
      trigger.appendChild(label);
      wrap.appendChild(trigger);
      select.parentNode.insertBefore(wrap, select);
      wrap.appendChild(select);
      select.setAttribute('aria-hidden', 'true');
      select.tabIndex = -1;
      function sync() { label.textContent = currentLabel(select); }
      sync();
      select.addEventListener('change', sync);
      trigger.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        openMenu(select, trigger, sync);
      });
      trigger.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openMenu(select, trigger, sync);
        }
      });
      var ownerLabel = wrap.closest('label');
      if (ownerLabel) {
        ownerLabel.removeAttribute('for');
        ownerLabel.addEventListener('click', function (event) {
          if (event.target.closest('.oui-select-trigger')) return;
          openMenu(select, trigger, sync);
        });
      }
    });
  }

  /* ------------------------------------------------------------- tooltips */

  function showTip(node, text) {
    ensure();
    tip.textContent = text;
    var rect = node.getBoundingClientRect();
    tip.hidden = false;
    var width = Math.min(260, Math.max(120, tip.offsetWidth));
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    var top = rect.bottom + 6;
    if (top + tip.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - tip.offsetHeight - 6);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip(restore) {
    window.clearTimeout(tipTimer);
    if (restore && tipTarget) {
      var text = tipTarget.getAttribute('data-omm-tip') || '';
      tipTarget.setAttribute('title', text);
      tipTarget.removeAttribute('data-omm-tip');
    }
    tipTarget = null;
    if (tip) tip.hidden = true;
  }

  function bindGlobal() {
    /* Mouse-activated controls must not keep a visible focus ring. Keyboard
       activation (event.detail === 0) keeps its focus for accessibility. */
    document.addEventListener('click', function (event) {
      if (event.detail === 0) return;
      var path = event.composedPath ? event.composedPath() : [event.target];
      for (var i = 0; i < path.length; i++) {
        var node = path[i];
        if (!node || !node.tagName) continue;
        if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') {
          var target = node;
          window.setTimeout(function () {
            try { if (target.blur) target.blur(); } catch (e) { /* ignore */ }
          }, 0);
          break;
        }
      }
    }, true);

    document.addEventListener('pointerdown', function (event) {
      if (!activeSelect) return;
      var path = event.composedPath ? event.composedPath() : [event.target];
      if (path.indexOf(menu) >= 0 || path.indexOf(activeSelect.trigger) >= 0) return;
      closeMenu();
    }, true);

    window.addEventListener('resize', function () { hideTip(true); closeMenu(); }, true);
    window.addEventListener('scroll', function () { hideTip(true); if (activeSelect) positionMenu(); }, true);
    window.addEventListener('keydown', function (event) {
      if (pending) {
        /* A modal surface owns the keyboard while it is open. */
        event.stopImmediatePropagation();
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        else if (event.key === 'Enter' && shadow.activeElement !== inputEl) {
          event.preventDefault(); finish(true);
        }
        return;
      }
      if (activeSelect) {
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopImmediatePropagation(); closeMenu(); return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); event.stopImmediatePropagation();
          var count = activeSelect.select.options.length;
          activeSelect.index = (activeSelect.index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
          paintMenu();
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopImmediatePropagation();
          chooseOption(activeSelect.index);
          return;
        }
      }
    }, true);

    /* Replace native title tooltips with an OMM-ZEN surface. The attribute is
       only removed while the pointer is over the element and restored as soon
       as it leaves, so any code reading title still sees the original value. */
    document.addEventListener('pointerover', function (event) {
      var node = event.target && event.target.closest ? event.target.closest('[title]') : null;
      if (!node || node === tipTarget) return;
      hideTip(true);
      var text = node.getAttribute('title') || '';
      if (!text.trim()) return;
      tipTarget = node;
      node.setAttribute('data-omm-tip', text);
      node.removeAttribute('title');
      var target = node;
      tipTimer = window.setTimeout(function () {
        if (tipTarget === target) showTip(target, text);
      }, 380);
    }, true);
    document.addEventListener('pointerout', function (event) {
      if (!tipTarget) return;
      var leaving = event.target === tipTarget ||
        (event.target && event.target.closest && event.target.closest('[data-omm-tip]') === tipTarget);
      if (!leaving) return;
      var next = event.relatedTarget;
      if (next && tipTarget.contains && tipTarget.contains(next)) return;
      hideTip(true);
    }, true);
    document.addEventListener('pointerdown', function () { hideTip(true); }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindGlobal, { once: true });
  } else {
    bindGlobal();
  }

  window.OMMUI = {
    confirm: confirm,
    alert: alertBox,
    prompt: promptBox,
    enhanceSelect: enhanceSelect,
    close: function () { finish(false); closeMenu(); hideTip(true); }
  };
})();

;(function () {
  'use strict'
  if (window.__ommDesktopLoaded) return
  window.__ommDesktopLoaded = true

  var API_ROOT = '/__omm/fs'

  /* ------------------------------------------------------------------ env */

  var ENV = (function () {
    var file = (location.pathname.split('/').pop() || '').toLowerCase()
    var match = file.match(/^omm-([a-z0-9_-]+)\.html$/)
    var appId = match ? match[1] : ''
    if (!appId && /\/$/.test(location.pathname) && /mdforge/i.test(document.title)) {
      appId = 'mdforge'
    }
    var embedded = false
    try {
      embedded = new URLSearchParams(location.search).get('omm_embed') === '1'
    } catch (e) {
      embedded = /[?&]omm_embed=1(?:&|$)/.test(location.search)
    }
    return { appId: appId, embedded: embedded }
  })()

  var originalCreateObjectURL = URL.createObjectURL
  var originalRevokeObjectURL = URL.revokeObjectURL
  var originalAnchorClick = HTMLAnchorElement.prototype.click
  var blobUrls = new Map()

  /* All confirmation dialogs go through the OMM-ZEN UI kit (never the
     browser's native confirm). Returns a Promise<boolean>. */
  function ask(message, opts) {
    if (window.OMMUI && window.OMMUI.confirm) return window.OMMUI.confirm(message, opts)
    return Promise.resolve(window.confirm(message))
  }

  /* ----------------------------------------------------------------- model */

  var model = {
    enabled: false,
    ready: false,
    shadow: null,
    shell: 'app', // 'app' | 'hub'
    open: false,
    pane: 'save',

    config: {
      path: '',
      mode: 'versioned',
      autoSnapshot: true,
      autoShare: false,
      sharePath: '',
      defaultPath: '',
      raw: null,
    },

    /* The archive is always viewed through a scope: one product or all. */
    scope: {
      app: '',
      appName: '',
      mode: 'app', // 'app' | 'all'
    },

    entries: [],
    apps: [],
    filters: { query: '', kind: 'all' },
    loading: false,
    error: '',
    seq: 0,
  }

  var focusTimer = 0
  var restoreTokens = {}
  var snapshotTokens = {}

  /* --------------------------------------------------------------- helpers */

  function isHub() {
    return model.shell === 'hub'
  }

  function isHubDocument() {
    return !!(document.body && document.body.dataset.ommShell === 'hub')
  }

  function effectiveApp() {
    return isHub() ? model.scope.app : ENV.appId
  }

  function effectiveAppName() {
    var app = effectiveApp()
    if (!app) return ''
    if (isHub() && model.scope.app === app && model.scope.appName) return model.scope.appName
    var known = appNameOf(app)
    if (known) return known
    var title = (document.title || '').trim()
    return title && !isHub() ? title : app
  }

  function appNameOf(app) {
    if (!app) return ''
    for (var i = 0; i < model.apps.length; i++) {
      if (model.apps[i] && model.apps[i].app === app && model.apps[i].name) {
        return model.apps[i].name
      }
    }
    return ''
  }

  function scopeShowsAll() {
    if (isHub() && !model.scope.app) return true
    return model.scope.mode === 'all'
  }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function fmtSize(bytes) {
    var size = Number(bytes) || 0
    if (!size) return '0 B'
    if (size < 1024) return size + ' B'
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
    return (size / 1024 / 1024).toFixed(1) + ' MB'
  }

  function fmtTime(value) {
    if (!value) return ''
    var date = new Date(value)
    if (isNaN(date.getTime())) return String(value)
    return date.toLocaleString()
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function byId(id) {
    return model.shadow ? model.shadow.getElementById(id) : null
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
    }
    return new Promise(function (resolve, reject) {
      try {
        var area = document.createElement('textarea')
        area.value = text
        area.style.cssText = 'position:fixed;opacity:0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
        resolve()
      } catch (e) {
        reject(e)
      }
    })
  }

  function toast(text, kind) {
    if (!model.shadow) return
    var box = byId('omm-toast')
    if (!box) return
    box.textContent = text
    box.dataset.kind = kind || 'info'
    box.classList.add('show')
    clearTimeout(box._timer)
    box._timer = setTimeout(function () {
      box.classList.remove('show')
    }, kind === 'error' ? 6000 : 3800)
  }

  /* ------------------------------------------------------------------- api */

  function apiUrl(path, params) {
    var list = []
    var all = Object.assign({ app: ENV.appId || undefined }, params || {})
    Object.keys(all).forEach(function (key) {
      if (all[key] === undefined || all[key] === null || all[key] === '') return
      list.push(encodeURIComponent(key) + '=' + encodeURIComponent(all[key]))
    })
    return API_ROOT + path + (list.length ? '?' + list.join('&') : '')
  }

  function request(path, options, params) {
    var opts = options || {}
    opts.cache = 'no-store'
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {})
      opts.body = JSON.stringify(opts.body)
    }
    return fetch(apiUrl(path, params), opts).then(function (res) {
      var type = res.headers.get('Content-Type') || ''
      if (type.indexOf('application/json') >= 0) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error((data && (data.error || data.message)) || '请求失败')
          return data
        })
      }
      if (!res.ok) throw new Error('请求失败 (' + res.status + ')')
      return res.arrayBuffer().then(function (buf) {
        return { ok: true, data: buf, type: type }
      })
    })
  }

  function apiGet(path, params) {
    return request(path, {}, params)
  }

  function apiPost(path, body, params) {
    return request(path, { method: 'POST', body: body }, params)
  }

  /* ------------------------------------------------------------- state I/O */

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () {
        var text = String(reader.result || '')
        resolve(text.slice(text.indexOf(',') + 1))
      }
      reader.onerror = function () {
        reject(reader.error || new Error('读取文件失败'))
      }
      reader.readAsDataURL(blob)
    })
  }

  function base64ToBlob(data, mime) {
    var binary = atob(data || '')
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: mime || 'application/octet-stream' })
  }

  function base64ToBytes(data) {
    var binary = atob(data || '')
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }

  async function encodeValue(value) {
    if (value === null || value === undefined) return value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value
    }
    if (value instanceof Blob) {
      return {
        __omm_type: 'blob',
        mime: value.type || 'application/octet-stream',
        name: value.name || '',
        data: await blobToBase64(value),
      }
    }
    if (value instanceof ArrayBuffer) {
      return { __omm_type: 'bytes', data: await blobToBase64(new Blob([value])) }
    }
    if (ArrayBuffer.isView(value)) {
      return {
        __omm_type: 'bytes',
        data: await blobToBase64(new Blob([value.buffer.slice(0)])),
      }
    }
    if (value instanceof Date) {
      return { __omm_type: 'date', value: value.toISOString() }
    }
    if (Array.isArray(value)) {
      var list = []
      for (var i = 0; i < value.length; i++) list.push(await encodeValue(value[i]))
      return list
    }
    if (typeof value === 'object') {
      var out = {}
      var keys = Object.keys(value)
      for (var k = 0; k < keys.length; k++) out[keys[k]] = await encodeValue(value[keys[k]])
      return out
    }
    return String(value)
  }

  function decodeValue(value) {
    if (value === null || value === undefined) return value
    if (Array.isArray(value)) return value.map(decodeValue)
    if (typeof value !== 'object') return value
    if (value.__omm_type === 'blob') {
      var blob = base64ToBlob(value.data, value.mime)
      if (value.name) {
        try {
          return new File([blob], value.name, { type: value.mime || blob.type })
        } catch (e) {
          return blob
        }
      }
      return blob
    }
    if (value.__omm_type === 'bytes') return base64ToBytes(value.data)
    if (value.__omm_type === 'date') return new Date(value.value)
    var out = {}
    Object.keys(value).forEach(function (key) {
      out[key] = decodeValue(value[key])
    })
    return out
  }

  function openDatabase(name, version, upgrade) {
    return new Promise(function (resolve, reject) {
      var req = version ? indexedDB.open(name, version) : indexedDB.open(name)
      req.onupgradeneeded = function (event) {
        if (typeof upgrade === 'function') {
          try {
            upgrade(req.result, event)
          } catch (e) {
            /* the records below may still restore */
          }
        }
      }
      req.onsuccess = function () {
        resolve(req.result)
      }
      req.onerror = function () {
        reject(req.error || new Error('打开数据库失败: ' + name))
      }
      req.onblocked = function () {
        reject(new Error('数据库被占用: ' + name))
      }
    })
  }

  function createSchema(db, info) {
    ;(info.stores || []).forEach(function (storeInfo) {
      if (db.objectStoreNames.contains(storeInfo.name)) return
      var store = db.createObjectStore(storeInfo.name, {
        keyPath: storeInfo.keyPath === null ? undefined : storeInfo.keyPath,
        autoIncrement: !!storeInfo.autoIncrement,
      })
      ;(storeInfo.indexes || []).forEach(function (idx) {
        try {
          store.createIndex(idx.name, idx.keyPath, {
            unique: !!idx.unique,
            multiEntry: !!idx.multiEntry,
          })
        } catch (e) {
          /* an index that cannot be recreated is not fatal */
        }
      })
    })
  }

  async function captureDatabase(name) {
    var db = await openDatabase(name)
    var stores = []
    var names = Array.prototype.slice.call(db.objectStoreNames)
    if (!names.length) {
      db.close()
      return { name: name, version: db.version, stores: [] }
    }
    var tx = db.transaction(names, 'readonly')
    for (var i = 0; i < names.length; i++) {
      var storeName = names[i]
      var store = tx.objectStore(storeName)
      var info = {
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: !!store.autoIncrement,
        indexes: [],
        records: [],
      }
      var idxNames = Array.prototype.slice.call(store.indexNames)
      idxNames.forEach(function (idxName) {
        var idx = store.index(idxName)
        info.indexes.push({
          name: idx.name,
          keyPath: idx.keyPath,
          unique: !!idx.unique,
          multiEntry: !!idx.multiEntry,
        })
      })
      var keys = await new Promise(function (resolve, reject) {
        var r = store.getAllKeys()
        r.onsuccess = function () { resolve(r.result || []) }
        r.onerror = function () { reject(r.error) }
      })
      var values = await new Promise(function (resolve, reject) {
        var r = store.getAll()
        r.onsuccess = function () { resolve(r.result || []) }
        r.onerror = function () { reject(r.error) }
      })
      for (var n = 0; n < values.length; n++) {
        info.records.push({
          key: await encodeValue(keys[n]),
          value: await encodeValue(values[n]),
        })
      }
      stores.push(info)
    }
    db.close()
    return { name: name, version: db.version, stores: stores }
  }

  async function captureState(label) {
    var snapshot = {
      version: 1,
      app: ENV.appId,
      label: label || '手动快照',
      taken_at: new Date().toISOString(),
      url: location.href,
      localStorage: {},
      sessionStorage: {},
      indexedDB: [],
    }
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i)
        snapshot.localStorage[key] = localStorage.getItem(key)
      }
    } catch (e) {
      /* private mode */
    }
    try {
      for (var s = 0; s < sessionStorage.length; s++) {
        var skey = sessionStorage.key(s)
        snapshot.sessionStorage[skey] = sessionStorage.getItem(skey)
      }
    } catch (e) {
      /* private mode */
    }
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') return snapshot
    var databases = []
    try {
      databases = await indexedDB.databases()
    } catch (e) {
      databases = []
    }
    for (var d = 0; d < databases.length; d++) {
      var info = databases[d]
      if (!info || !info.name) continue
      try {
        snapshot.indexedDB.push(await captureDatabase(info.name))
      } catch (e) {
        /* a busy database should not break the rest of the snapshot */
      }
    }
    return snapshot
  }

  async function restoreDatabase(info) {
    if (!info || !info.name) return
    var db = null
    try {
      db = await openDatabase(info.name)
    } catch (e) {
      db = await openDatabase(info.name, info.version || 1, function (up) {
        createSchema(up, info)
      })
    }
    var missing = (info.stores || []).filter(function (storeInfo) {
      return !db.objectStoreNames.contains(storeInfo.name)
    })
    if (missing.length) {
      var nextVersion = (db.version || 1) + 1
      db.close()
      db = await openDatabase(info.name, nextVersion, function (up) {
        createSchema(up, info)
      })
    }
    for (var i = 0; i < (info.stores || []).length; i++) {
      var storeInfo = info.stores[i]
      if (!db.objectStoreNames.contains(storeInfo.name)) continue
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(storeInfo.name, 'readwrite')
        var store = tx.objectStore(storeInfo.name)
        var r = store.clear()
        r.onerror = function () { reject(r.error) }
        r.onsuccess = function () {
          var records = storeInfo.records || []
          for (var n = 0; n < records.length; n++) {
            var record = records[n]
            var value = decodeValue(record.value)
            if (storeInfo.keyPath === null || storeInfo.keyPath === undefined) {
              store.put(value, decodeValue(record.key))
            } else {
              store.put(value)
            }
          }
        }
        tx.oncomplete = function () { resolve() }
        tx.onerror = function () { reject(tx.error) }
        tx.onabort = function () { reject(tx.error || new Error('恢复事务中止')) }
      })
    }
    db.close()
  }

  async function applyState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('快照内容无效')
    var ls = snapshot.localStorage || {}
    try {
      Object.keys(localStorage).forEach(function (key) {
        localStorage.removeItem(key)
      })
      Object.keys(ls).forEach(function (key) {
        localStorage.setItem(key, String(ls[key]))
      })
    } catch (e) {
      throw new Error('写入本地数据失败: ' + (e && e.message ? e.message : e))
    }
    var ss = snapshot.sessionStorage || {}
    try {
      Object.keys(sessionStorage).forEach(function (key) {
        sessionStorage.removeItem(key)
      })
      Object.keys(ss).forEach(function (key) {
        sessionStorage.setItem(key, String(ss[key]))
      })
    } catch (e) {
      /* session storage is best effort */
    }
    var dbs = snapshot.indexedDB || []
    for (var i = 0; i < dbs.length; i++) {
      await restoreDatabase(dbs[i])
    }
    location.reload()
  }

  /* A short, human readable inventory of what a snapshot contains.  This is
     what the ⓘ button under each snapshot shows, so "what is a snapshot?"
     is answered with the actual record instead of a generic paragraph. */
  function summarizeSnapshot(snapshot) {
    var snap = snapshot || {}
    var ls = Object.keys(snap.localStorage || {})
    var ss = Object.keys(snap.sessionStorage || {})
    var dbs = snap.indexedDB || []
    var stores = 0
    var records = 0
    dbs.forEach(function (db) {
      var list = db.stores || []
      stores += list.length
      list.forEach(function (store) {
        records += (store.records || []).length
      })
    })
    function preview(keys) {
      if (!keys.length) return '无'
      return keys.length + ' 项 · ' + keys.slice(0, 5).join('、') + (keys.length > 5 ? ' …' : '')
    }
    return [
      ['记录时间', fmtTime(snap.taken_at) + (snap.saved_at ? '（写入于 ' + fmtTime(snap.saved_at) + '）' : '')],
      ['本地存储', preview(ls)],
      ['会话存储', preview(ss)],
      ['IndexedDB', dbs.length ? dbs.length + ' 个数据库 · ' + stores + ' 个存储区 · ' + records + ' 条记录' : '无'],
      ['页面地址', snap.url || '—'],
      ['恢复效果', '覆盖该应用当前数据，并自动重载页面'],
    ]
  }

  /* ----------------------------------------------------------------- saving */

  function fallbackDownload(blob, filename) {
    try {
      var url = originalCreateObjectURL.call(URL, blob)
      var anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename || 'omm-export.bin'
      originalAnchorClick.call(anchor)
      setTimeout(function () { originalRevokeObjectURL.call(URL, url) }, 30000)
    } catch (e) {
      /* nothing else we can do */
    }
  }

  function fingerprint(text) {
    var sample = text.slice(0, 2048) + text.slice(-2048)
    var hash = 2166136261
    for (var i = 0; i < sample.length; i++) {
      hash ^= sample.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return text.length + ':' + (hash >>> 0)
  }

  var lastFingerprint = ''
  var lastSnapshotAt = 0

  function notifyHubSaved() {
    if (!ENV.embedded) return
    try {
      window.parent.postMessage({ type: 'omm:saved', app: ENV.appId }, '*')
    } catch (e) {
      /* ignore */
    }
  }

  async function saveBlob(filename, blob, options) {
    if (!model.enabled) return false
    var opts = options || {}
    try {
      var data = await blobToBase64(blob)
      var payload = {
        app: ENV.appId,
        name: filename || 'omm-export.bin',
        mime: blob.type || '',
        data: data,
        mode: opts.mode || model.config.mode,
        label: opts.label || '保存 ' + (filename || ''),
      }
      var isHubShell = ENV.appId === 'hub'
      if (opts.snapshot !== false && model.config.autoSnapshot && !isHubShell) {
        try {
          var snapshot = await captureState(payload.label)
          var fp = fingerprint(JSON.stringify(snapshot))
          if (fp !== lastFingerprint || Date.now() - lastSnapshotAt > 60000) {
            payload.state = snapshot
            lastFingerprint = fp
            lastSnapshotAt = Date.now()
          }
        } catch (e) {
          /* a failed snapshot must not fail the save */
        }
      }
      var result = await apiPost('/save', payload)
      toast('已保存 ' + result.filename + (result.mode === 'versioned' ? '（历史版本）' : '') + '\n' + result.path)
      notifyHubSaved()
      if (model.open) loadArchive()
      if (!isHubShell && model.config.autoShare && window.OMMShare && window.OMMShare.enabled) {
        window.OMMShare.publishFile({
          path: result.path,
          name: result.filename,
          title: filename || result.filename,
          type: blob.type || '',
          replaceKey: 'auto:' + (filename || result.filename),
        }).catch(function () {
          /* A channel that does not accept this type is not an error. */
        })
      }
      return result
    } catch (err) {
      toast('保存失败：' + (err && err.message ? err.message : err), 'error')
      fallbackDownload(blob, filename)
      throw err
    }
  }

  function saveText(filename, text, mime, options) {
    return saveBlob(filename, new Blob([text], { type: mime || 'text/plain;charset=utf-8' }), options)
  }

  function installHooks() {
    URL.createObjectURL = function (obj) {
      var url = originalCreateObjectURL.call(URL, obj)
      try {
        if (obj instanceof Blob) blobUrls.set(url, obj)
      } catch (e) {
        /* ignore */
      }
      return url
    }
    URL.revokeObjectURL = function (url) {
      setTimeout(function () { blobUrls.delete(url) }, 120000)
      return originalRevokeObjectURL.call(URL, url)
    }
    HTMLAnchorElement.prototype.click = function () {
      var href = this.href || ''
      var name = this.getAttribute('download')
      if (model.enabled && name && (blobUrls.has(href) || /^data:/i.test(href))) {
        var blob = blobUrls.get(href)
        if (!blob && /^data:/i.test(href)) {
          try {
            var parts = href.split(',')
            var mime = (parts[0].match(/data:([^;]+)/) || [])[1] || 'application/octet-stream'
            blob = base64ToBlob(parts[1] || '', mime)
          } catch (e) {
            blob = null
          }
        }
        if (blob) {
          saveBlob(name, blob).catch(function () {})
          return
        }
      }
      return originalAnchorClick.apply(this, arguments)
    }

    /* Server-generated downloads (MdForge / LaTeX) are plain links.  Fetch
       them into a Blob so they follow the same save path rules. */
    document.addEventListener('click', function (event) {
      if (!model.enabled) return
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return
      var href = anchor.href || ''
      if (!/\/api\/download\//i.test(href) && !/\/pdf\?/i.test(href)) return
      event.preventDefault()
      event.stopPropagation()
      fetch(href, { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('下载失败 (' + res.status + ')')
        var disposition = res.headers.get('Content-Disposition') || ''
        var name = ''
        var utf = disposition.match(/filename\*=UTF-8''([^;]+)/i)
        if (utf) {
          try { name = decodeURIComponent(utf[1]) } catch (e) { /* ignore */ }
        }
        if (!name) {
          var plain = disposition.match(/filename="?([^";]+)"?/i)
          if (plain) name = plain[1]
        }
        if (!name) {
          var last = (href.split('?')[0].split('/').pop() || 'download').toLowerCase()
          name = /\/pdf$/.test(href.split('?')[0]) || /\/pdf\?/i.test(href) ? 'main.pdf' : last || 'download.bin'
        }
        return res.blob().then(function (blob) { return saveBlob(name, blob) })
      }).catch(function (err) {
        toast('保存失败：' + (err && err.message ? err.message : err), 'error')
        window.open(href, '_blank', 'noopener')
      })
    }, true)
  }

  /* --------------------------------------------------------- shared files */

  /* Hand bytes to the best input of the current product.  Used both by the
     archive ("open in app") and by the share inbox, so a document arriving
     from another product takes exactly the same path as a local file. */
  function loadBlob(name, mime, buf) {
    var fileName = name || 'shared-file'
    var type = mime || 'application/octet-stream'
    var file
    try {
      file = new File([buf], fileName, { type: type })
    } catch (e) {
      file = new Blob([buf], { type: type })
      file.name = fileName
    }
    var ext = ('.' + (fileName.split('.').pop() || '')).toLowerCase()
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"]'))
    var best = null
    var bestScore = -1
    inputs.forEach(function (input) {
      var accept = (input.getAttribute('accept') || '').toLowerCase()
      var score = 0
      if (accept.indexOf(ext) >= 0) score += 4
      if (accept.indexOf('*') >= 0 || accept.indexOf('application/octet-stream') >= 0) score += 1
      if (input.offsetParent !== null) score += 2
      if (input.id && /file|import|input/i.test(input.id)) score += 1
      if (score > bestScore) {
        bestScore = score
        best = input
      }
    })
    if (best && bestScore > 0) {
      try {
        var dt = new DataTransfer()
        dt.items.add(file)
        best.files = dt.files
        best.dispatchEvent(new Event('change', { bubbles: true }))
        toast('已载入 ' + fileName)
        return { ok: true, input: best.id || 'file-input' }
      } catch (e) {
        /* fall through to the editor path */
      }
    }
    if (['.md', '.markdown', '.txt', '.tex'].indexOf(ext) >= 0) {
      var text = new TextDecoder('utf-8').decode(buf)
      var editor = document.getElementById('editor') || document.querySelector('#tex, textarea.tex')
      if (editor && 'value' in editor) {
        editor.value = text
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        editor.dispatchEvent(new Event('change', { bubbles: true }))
        toast('已载入 ' + fileName + ' 到编辑器')
        return { ok: true, editor: true }
      }
    }
    return { ok: false }
  }

  function loadResource(resource) {
    if (!resource || !resource.path) return Promise.resolve(false)
    var name = resource.name || resource.file || 'shared-file'
    var mime = resource.mime || 'application/octet-stream'
    toast('正在载入 ' + name + '…')
    return fetch(apiUrl('/file', { app: ENV.appId, path: resource.path }), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('读取共享文件失败')
        return res.arrayBuffer()
      })
      .then(function (buf) {
        var result = loadBlob(name, mime, buf)
        if (result.ok) return result
        copyText(resource.path).catch(function () {})
        toast('当前应用没有自动载入入口，路径已复制：' + resource.path, 'error')
        return { ok: false, path: resource.path }
      })
      .catch(function (err) {
        toast('载入失败：' + (err && err.message ? err.message : err), 'error')
        throw err
      })
  }

  /* ------------------------------------------------------------------- css */

  var PANEL_CSS = [
    ':host{all:initial;--omm-radius:var(--radius,0px)}',
    '*{box-sizing:border-box}',
    '.omm-btn{position:fixed;left:16px;bottom:84px;z-index:2147482100;pointer-events:auto;',
    '  display:flex;align-items:center;gap:4px;border:1px solid var(--omm-ink, #26231f);background:var(--omm-paper, #ffffff);',
    '  color:var(--omm-ink, #26231f);font:600 11px/1 "Literata","Songti SC","SimSun",serif;letter-spacing:.04em;',
    '  padding:5px 7px;cursor:pointer;box-shadow:0 3px 10px rgba(38,35,31,.10);border-radius:var(--omm-radius,0px)}',
    '.omm-btn:hover{background:var(--omm-soft, #f2eee7);border-color:var(--omm-ink, #26231f);color:var(--omm-ink, #26231f)}',
    '.omm-panel{position:fixed;left:16px;bottom:132px;z-index:2147482101;pointer-events:auto;',
    '  width:min(600px,calc(100vw - 32px));max-height:min(74vh,720px);display:none;flex-direction:column;',
    '  background:var(--omm-paper, #ffffff);color:var(--omm-ink, #26231f);border:1px solid var(--omm-ink, #26231f);border-radius:var(--omm-radius,0px);',
    '  box-shadow:0 22px 60px rgba(38,35,31,.24);font:12px/1.55 "Literata","Songti SC","SimSun",serif}',
    '.omm-panel.open{display:flex}',
    ':host([data-shell="hub"]) .omm-btn{display:none}',
    ':host([data-embedded="1"]) .omm-btn{display:none}',
    ':host([data-shell="hub"]) .omm-panel{left:auto;right:16px;bottom:auto;top:calc(var(--topbar,46px) + 8px);',
    '  width:min(540px,calc(100vw - 32px));max-height:min(78vh,760px)}',
    '.omm-head{display:flex;align-items:center;justify-content:space-between;padding:11px 13px;border-bottom:1px solid var(--omm-line-soft, #d9d3c8)}',
    '.omm-head b{font-size:14px;letter-spacing:.04em}',
    '.omm-x{border:0;background:transparent;font-size:17px;cursor:pointer;color:var(--omm-ink, #26231f);padding:0 4px;border-radius:var(--omm-radius,0px)}',
    '.omm-x:hover{background:var(--omm-soft, #f2eee7)}',
    '.omm-tabs{display:flex;gap:2px;padding:7px 11px 0;border-bottom:1px solid var(--omm-line-soft, #d9d3c8)}',
    '.omm-tabs button{border:0;background:transparent;font:inherit;padding:5px 9px;cursor:pointer;color:var(--omm-dim, #6d6559);',
    '  border-bottom:2px solid transparent;border-radius:var(--omm-radius,0px) var(--omm-radius,0px) 0 0}',
    '.omm-tabs button[aria-selected="true"]{color:var(--omm-ink, #26231f);border-color:var(--omm-ink, #26231f);font-weight:700}',
    '.omm-tabs button:focus-visible{outline:1px solid var(--omm-ink, #26231f);outline-offset:-1px}',
    '.omm-body{padding:11px 13px 13px;overflow:auto;flex:1 1 auto;min-height:160px}',
    '.omm-pane{display:none}.omm-pane.active{display:block}',
    '.omm-label{display:block;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--omm-dim, #6d6559);margin:9px 0 4px}',
    '.omm-input{width:100%;padding:7px 8px;border:1px solid #b9b1a3;background:var(--omm-paper, #ffffff);font:inherit;color:var(--omm-ink, #26231f);border-radius:var(--omm-radius,0px)}',
    '.omm-input:focus{outline:1px solid var(--omm-ink, #26231f);border-color:var(--omm-ink, #26231f)}',
    '.omm-input:disabled{background:#f7f4ee;color:#9c9486}',
    '.omm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:7px 0}',
    '.omm-row label{display:flex;align-items:center;gap:6px;cursor:pointer}',
    '.omm-row label[data-disabled="1"]{cursor:default;color:#9c9486}',
    '.omm-row input[type="checkbox"],.omm-row input[type="radio"]{',
    '  -webkit-appearance:none;appearance:none;width:13px;height:13px;margin:0;flex:0 0 auto;',
    '  border:1px solid var(--omm-ink, #26231f);background:var(--omm-paper, #ffffff);position:relative;display:inline-block;',
    '  vertical-align:-2px;cursor:pointer;accent-color:var(--omm-ink, #26231f);border-radius:var(--omm-radius,0px)}',
    '.omm-row input[type="radio"]{border-radius:50%}',
    '.omm-row input[type="checkbox"]:checked,.omm-row input[type="radio"]:checked{background:var(--omm-soft, #f2eee7)}',
    '.omm-row input[type="checkbox"]:checked::after{content:"";position:absolute;left:3px;top:0;',
    '  width:4px;height:8px;border:solid var(--omm-ink, #26231f);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}',
    '.omm-row input[type="radio"]:checked::after{content:"";position:absolute;left:3px;top:3px;',
    '  width:5px;height:5px;border-radius:50%;background:var(--omm-ink, #26231f)}',
    '.omm-row input[type="checkbox"]:focus-visible,.omm-row input[type="radio"]:focus-visible{outline:1px solid var(--omm-ink, #26231f);outline-offset:2px}',
    '.omm-row input:disabled{opacity:.4;cursor:default}',
    '.omm-primary,.omm-secondary{border:1px solid var(--omm-ink, #26231f);font:inherit;font-size:11.5px;padding:5px 11px;cursor:pointer;',
    '  background:var(--omm-paper, #ffffff);color:var(--omm-ink, #26231f);border-radius:var(--omm-radius,0px)}',
    '.omm-primary{background:var(--omm-soft, #f2eee7)}.omm-primary:hover,.omm-secondary:hover{background:#e8dfd1}',
    '.omm-primary:disabled,.omm-secondary:disabled{opacity:.45;cursor:default}',
    '.omm-primary:focus-visible,.omm-secondary:focus-visible{outline:1px solid var(--omm-ink, #26231f);outline-offset:2px}',
    '.omm-note{color:var(--omm-dim, #6d6559);font-size:11.5px;margin-top:6px;word-break:break-all}',
    '.omm-section{margin-top:12px;border-top:1px solid #ece7de;padding-top:2px}',
    '.omm-lead{color:var(--omm-dim, #6d6559);font-size:11px;line-height:1.55;margin:0 0 6px;padding:5px 8px;background:var(--omm-soft, #faf7f1);border-left:2px solid var(--omm-line-soft, #d9d3c8)}',
    '.omm-scope{display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:11px;color:var(--omm-dim, #6d6559);margin:0 0 3px}',
    '.omm-scope b{color:var(--omm-ink, #26231f);font-weight:600}',
    '.omm-help{margin:7px 0;padding:6px 8px;border-left:2px solid var(--omm-line-soft, #d9d3c8);background:var(--omm-soft, #faf7f1);color:var(--omm-dim, #6d6559);font-size:11px;line-height:1.55}',
    '.omm-help b{color:var(--omm-ink, #26231f);font-weight:600}',
    '.omm-search{position:relative;margin:8px 0 5px}',
    '.omm-search .omm-input{padding-right:28px}',
    '.omm-search button{position:absolute;right:5px;top:50%;transform:translateY(-50%);border:0;background:transparent;',
    '  color:var(--omm-dim, #6d6559);font:14px/1 inherit;cursor:pointer;padding:2px;display:none}',
    '.omm-search.has-value button{display:block}',
    '.omm-search button:hover{color:var(--omm-ink, #26231f)}',
    '.omm-chips{display:flex;gap:4px;margin:0 0 2px;flex-wrap:wrap}',
    '.omm-chips button{border:1px solid var(--omm-line-soft, #c9c1b3);background:var(--omm-paper, #ffffff);color:var(--omm-dim, #6d6559);font:inherit;font-size:10.5px;',
    '  padding:2px 9px;cursor:pointer;border-radius:var(--omm-radius,0px)}',
    '.omm-chips button:hover{border-color:var(--omm-ink, #26231f);color:var(--omm-ink, #26231f)}',
    '.omm-chips button[aria-pressed="true"]{background:var(--omm-ink, #26231f);border-color:var(--omm-ink, #26231f);color:var(--omm-paper, #ffffff)}',
    '.omm-list{border:1px solid var(--omm-line-soft, #d9d3c8);margin-top:6px;border-radius:var(--omm-radius,0px)}',
    '.omm-item{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:8px 9px;border-bottom:1px solid #ece7de}',
    '.omm-item:last-child{border-bottom:0}',
    '.omm-item:hover{background:#fbf8f2}',
    '.omm-item-main{min-width:0;flex:1}',
    '.omm-item-head{display:flex;align-items:center;gap:4px;min-width:0}',
    '.omm-item-head b{display:block;min-width:0;max-width:100%;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.omm-meta{color:var(--omm-dim, #6d6559);font-size:11px;word-break:break-all;margin-top:1px}',
    '.omm-actions{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;max-width:210px}',
    '.omm-actions button{border:1px solid #bcb3a4;background:var(--omm-paper, #ffffff);color:var(--omm-ink, #26231f);font:inherit;font-size:11px;padding:3px 7px;',
    '  cursor:pointer;white-space:nowrap;border-radius:var(--omm-radius,0px)}',
    '.omm-actions button:hover{background:var(--omm-soft, #f2eee7);color:var(--omm-ink, #26231f);border-color:var(--omm-ink, #26231f)}',
    '.omm-actions button:disabled{opacity:.38;cursor:default;background:var(--omm-paper, #ffffff);color:var(--omm-ink, #26231f)}',
    '.omm-actions button.danger:hover{background:#f7e4e1;border-color:#8f2f27;color:#8f2f27}',
    '.omm-actions button:focus-visible{outline:1px solid var(--omm-ink, #26231f);outline-offset:1px}',
    '.omm-empty{padding:22px 10px;text-align:center;color:var(--omm-dim, #6d6559);font-size:12px;line-height:1.7;white-space:pre-line}',
    '.omm-badge{display:inline-block;border:1px solid var(--omm-line-soft, #c9c1b3);padding:0 5px;margin-right:5px;font-size:10px;',
    '  color:var(--omm-dim, #6d6559);border-radius:var(--omm-radius,0px)}',
    '.omm-kind{display:inline-block;border:1px solid var(--omm-ink, #26231f);padding:0 5px;margin-right:5px;font-size:10px;',
    '  letter-spacing:.02em;color:var(--omm-ink, #26231f);border-radius:var(--omm-radius,0px)}',
    '.omm-kind[data-kind="snapshot"]{background:var(--omm-soft, #f2eee7)}',
    '.omm-kind[data-kind="file"]{background:var(--omm-paper, #ffffff)}',
    '.omm-info{flex:0 0 auto;width:15px;height:15px;border:1px solid #bcb3a4;background:var(--omm-paper, #ffffff);color:var(--omm-dim, #6d6559);',
    '  font:600 10px/1 "Literata","Songti SC",serif;cursor:pointer;padding:0;border-radius:50%}',
    '.omm-info:hover{border-color:var(--omm-ink, #26231f);color:var(--omm-ink, #26231f)}',
    '.omm-detail{margin-top:6px;padding:6px 7px;background:var(--omm-soft, #faf7f1);border:1px dashed var(--omm-line-soft, #d9d3c8);',
    '  font-size:10.5px;line-height:1.55;color:var(--omm-dim, #6d6559)}',
    '.omm-detail div{display:flex;gap:6px;margin:1px 0}',
    '.omm-detail span:first-child{flex:0 0 58px;color:var(--omm-dim, #6d6559)}',
    '.omm-detail span:last-child{flex:1;word-break:break-all}',
    '.omm-rename{display:flex;gap:4px;margin:3px 0 4px}',
    '.omm-rename input{flex:1;min-width:0;padding:3px 6px;border:1px solid var(--omm-ink, #26231f);background:var(--omm-paper, #ffffff);color:var(--omm-ink, #26231f);',
    '  font:inherit;font-size:11.5px;border-radius:var(--omm-radius,0px)}',
    '.omm-rename button{border:1px solid var(--omm-ink, #26231f);background:var(--omm-paper, #ffffff);color:var(--omm-ink, #26231f);font:inherit;font-size:11px;padding:2px 7px;',
    '  cursor:pointer;border-radius:var(--omm-radius,0px)}',
    '.omm-rename button:hover{background:var(--omm-soft, #f2eee7)}',
    '.omm-foot{margin-top:6px;color:var(--omm-dim, #6d6559);font-size:10.5px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}',
    '.omm-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,16px);z-index:2147482200;pointer-events:none;',
    '  max-width:min(680px,calc(100vw - 40px));padding:8px 13px;background:var(--omm-paper, #ffffff);color:var(--omm-ink, #26231f);border:1px solid var(--omm-ink, #26231f);',
    '  border-radius:var(--omm-radius,0px);',
    '  font:12px/1.5 "Literata","Songti SC","SimSun",serif;white-space:pre-wrap;opacity:0;transition:.18s}',
    '.omm-toast.show{opacity:1;transform:translate(-50%,0)}',
    '.omm-toast[data-kind="error"]{background:#fdf0ee;border-color:#8f2f27;color:#8f2f27}',
    /* ---------------------------------------------------------------- *
     * Appearance overrides. Accent, radius and focus are all derived from
     * the shell variables above, so no surface keeps a hard-coded hue.
     * This also styles the share panel (.osh-*) injected into this shadow
     * root by omm-share.js.
     * ---------------------------------------------------------------- */
    '.omm-panel{border-color:var(--omm-accent-line);overflow:hidden;',
    '  box-shadow:0 22px 60px var(--omm-shadow),inset 0 3px 0 var(--omm-accent)}',
    '.omm-btn{border-color:var(--omm-accent);',
    '  box-shadow:0 3px 10px var(--omm-shadow),inset 0 -2px 0 var(--omm-accent)}',
    '.omm-btn:hover{background:var(--omm-accent-soft)}',
    '.omm-head{border-bottom:1px solid var(--omm-accent-line);background:var(--omm-accent-wash)}',
    '.omm-head b::before{content:"";display:inline-block;width:3px;height:13px;margin-right:7px;',
    '  vertical-align:-2px;background:var(--omm-accent);border-radius:var(--omm-radius)}',
    '.omm-tabs{border-bottom:1px solid var(--omm-accent-line)}',
    '.omm-tabs button:hover{background:var(--omm-accent-wash)}',
    '.omm-tabs button[aria-selected="true"]{border-color:var(--omm-accent);',
    '  background:var(--omm-accent-soft);color:var(--omm-ink)}',
    '.omm-label{color:var(--omm-accent)}',
    '.omm-input{border-color:var(--omm-accent-line)}',
    '.omm-input:focus{outline:1px solid var(--omm-accent-line);border-color:var(--omm-accent)}',
    '.omm-input:disabled{background:var(--omm-soft);color:var(--omm-dim)}',
    '.omm-row label[data-disabled="1"]{color:var(--omm-dim)}',
    '.omm-row input[type="checkbox"]:checked,.omm-row input[type="radio"]:checked{',
    '  background:var(--omm-accent-soft);border-color:var(--omm-accent)}',
    '.omm-row input[type="checkbox"]:checked::after{border-color:var(--omm-accent)}',
    '.omm-row input[type="radio"]:checked::after{background:var(--omm-accent)}',
    '.omm-primary{background:var(--omm-accent-soft);border-color:var(--omm-accent)}',
    '.omm-secondary{border-color:var(--omm-accent-line)}',
    '.omm-primary:hover,.omm-secondary:hover{background:var(--omm-accent-soft)}',
    '.omm-lead,.omm-help{border-left:2px solid var(--omm-accent);background:var(--omm-accent-wash)}',
    '.omm-section{border-top:1px solid var(--omm-accent-line)}',
    '.omm-chips button{border-color:var(--omm-accent-line)}',
    '.omm-chips button[aria-pressed="true"]{background:var(--omm-accent);',
    '  border-color:var(--omm-accent);color:var(--omm-accent-contrast)}',
    '.omm-list{border-color:var(--omm-accent-line)}',
    '.omm-item{border-bottom:1px solid var(--omm-line-soft)}',
    '.omm-item:hover{background:var(--omm-accent-wash)}',
    '.omm-actions button{border-color:var(--omm-accent-line)}',
    '.omm-actions button:hover{background:var(--omm-accent-wash);border-color:var(--omm-accent)}',
    '.omm-actions button.danger:hover{background:var(--omm-danger-soft);',
    '  border-color:var(--omm-danger);color:var(--omm-danger)}',
    '.omm-badge,.omm-kind{border-color:var(--omm-accent-line)}',
    '.omm-kind[data-kind="snapshot"]{background:var(--omm-accent-soft)}',
    '.omm-info{border-color:var(--omm-accent-line)}',
    '.omm-info:hover{border-color:var(--omm-accent);color:var(--omm-accent)}',
    '.omm-detail{border:1px dashed var(--omm-accent-line);background:var(--omm-accent-wash)}',
    '.omm-rename input{border-color:var(--omm-accent)}',
    '.omm-toast{border-color:var(--omm-accent);border-left:3px solid var(--omm-accent);',
    '  box-shadow:0 10px 34px var(--omm-shadow)}',
    '.omm-toast[data-kind="error"]{background:var(--omm-danger-soft);',
    '  border-color:var(--omm-danger);color:var(--omm-danger)}',
    '.omm-search button{color:var(--omm-accent)}',
    '.osh-lead{border-left:2px solid var(--omm-accent);background:var(--omm-accent-wash)}',
    '.osh-chip{border-color:var(--omm-accent-line)}',
    '.osh-chip[aria-pressed="true"]{background:var(--omm-accent);',
    '  border-color:var(--omm-accent);color:var(--omm-accent-contrast)}',
    '.osh-chip:hover{border-color:var(--omm-accent)}',
    '.osh-list,.osh-rule,.osh-preview,.osh-batch{border-color:var(--omm-accent-line)}',
    '.osh-batch{background:var(--omm-accent-wash)}',
    '.osh-batch button,.osh-member input[type="checkbox"]{border-color:var(--omm-accent-line)}',
    '.osh-batch button:hover{border-color:var(--omm-accent)}',
    '.osh-batch button.danger,.osh-item button.danger{color:var(--omm-danger)}',
    '.osh-item:hover{background:var(--omm-accent-wash)}',
    '.osh-member input[type="checkbox"]:checked{background:var(--omm-accent-soft);border-color:var(--omm-accent)}',
    /* Every bordered element inside the archive panel follows --radius. */
    '.omm-panel,.omm-head,.omm-x,.omm-tabs,.omm-tabs button,.omm-body,.omm-pane,.omm-label,',
    '.omm-input,.omm-row,.omm-primary,.omm-secondary,.omm-note,.omm-section,.omm-lead,',
    '.omm-scope,.omm-help,.omm-search,.omm-chips,.omm-chips button,.omm-list,.omm-item,',
    '.omm-item-main,.omm-item-head,.omm-meta,.omm-actions,.omm-actions button,.omm-empty,',
    '.omm-badge,.omm-kind,.omm-detail,.omm-rename,.omm-rename input,.omm-rename button,',
    '.omm-foot,.omm-toast,.omm-content-hits,.omm-content-head,.omm-content-snippet,',
    '.omm-compare,.omm-compare-out,.omm-btn,.osh-lead,.osh-bar,.osh-summary,.osh-chips,',
    '.osh-chip,.osh-list,.osh-empty,.osh-foot,.osh-rules,.osh-rule,.osh-rule-head,',
    '.osh-member,.osh-note,.osh-target,.osh-item,.osh-preview,.osh-batch,.osh-batch button',
    '{border-radius:var(--omm-radius)}',
    '.omm-tabs button{border-radius:var(--omm-radius) var(--omm-radius) 0 0}',
    'button:focus:not(:focus-visible),input:focus:not(:focus-visible){outline:none}',
    'button:focus-visible{outline:1px solid var(--omm-accent);outline-offset:1px}',
    'input[type="search"]::-webkit-search-cancel-button,',
    'input[type="search"]::-webkit-search-decoration{-webkit-appearance:none;appearance:none}'
  ].join('')

  /* ------------------------------------------------------------------ html */

  var PANEL_VARS =
    /* Accent, radius and shadows are inherited from the shell document, so the
       archive panel (and the share panel inside it) always follows the current
       OMM-ZEN theme. Fallbacks keep standalone product pages readable. */
    ':host{--omm-radius:var(--radius,0px);' +
    '--omm-accent:var(--accent,#e3a400);' +
    '--omm-accent-soft:var(--accent-soft,rgba(227,164,0,.16));' +
    '--omm-accent-wash:var(--accent-wash,rgba(227,164,0,.08));' +
    '--omm-accent-line:var(--accent-line,rgba(227,164,0,.5));' +
    '--omm-accent-contrast:var(--accent-contrast,#ffffff);' +
    '--omm-danger:var(--danger,#8f2f27);' +
    '--omm-danger-soft:var(--danger-soft,#f7e4e1);' +
    '--omm-shadow:var(--shadow-deep,rgba(38,35,31,.24));' +
    /* Base colours are inherited too, so light/dark switching works in the
       hub without waiting for a postMessage. Fallbacks serve product pages
       that have no shell stylesheet. */
    '--omm-ink:var(--ink,#26231f);' +
    '--omm-paper:var(--paper,#ffffff);' +
    '--omm-soft:var(--soft,#f2eee7);' +
    '--omm-dim:var(--dim,#6d6559);' +
    '--omm-line-soft:var(--line-soft,#d9d3c8)}' +
    ':host(.omm-dark){--omm-ink:#e9e5dd;--omm-paper:#292622;--omm-soft:#37332d;--omm-dim:#a89f90;' +
    '--omm-line-soft:#4a443c;--omm-shadow:rgba(0,0,0,.5)}' +
    ':host(.omm-dark) .omm-panel{box-shadow:0 22px 60px var(--omm-shadow)}' +
    ':host(.omm-dark) .omm-toast{box-shadow:0 10px 34px var(--omm-shadow)}' +
    '.omm-content-hits{border:1px solid var(--omm-accent-line);border-radius:var(--omm-radius);margin-bottom:6px;background:var(--omm-paper)}' +
    '.omm-content-head{padding:6px 8px;border-bottom:1px solid var(--omm-accent-line);font-size:11px}' +
    '.omm-content-head b{font-weight:700}' +
    '.omm-content-snippet{margin-top:3px;font-size:10.5px;line-height:1.5;color:var(--omm-dim);word-break:break-all}' +
    '.omm-hit{border:0;border-bottom:1px solid var(--omm-line-soft);border-radius:0}' +
    '.omm-hit:last-child{border-bottom:0}' +
    '.omm-compare{border:1px solid var(--omm-accent-line);background:var(--omm-accent-soft);color:var(--omm-ink);font:inherit;font-size:10.5px;padding:2px 6px;cursor:pointer;border-radius:var(--omm-radius)}' +
    '.omm-compare:hover{border-color:var(--omm-accent)}' +
    '.omm-compare:disabled{opacity:.55;cursor:default}' +
    '.omm-compare-out{margin-left:6px;color:var(--omm-dim);font-size:10px;word-break:break-all}';

  var PANEL_HTML = [
    '<button class="omm-btn" id="omm-open" type="button" title="保存路径、历史快照与跨产品共享">▣ 存档</button>',
    '<section class="omm-panel" id="omm-panel" role="dialog" aria-label="OMM-ZEN 存档">',
    '  <div class="omm-head"><b>存档与共享</b><button class="omm-x" id="omm-close" type="button" aria-label="关闭">×</button></div>',
    '  <div class="omm-tabs" role="tablist">',
    '    <button type="button" role="tab" data-pane="save" aria-selected="true">保存设置</button>',
    '    <button type="button" role="tab" data-pane="archive" aria-selected="false">存档历史</button>',
    '    <button type="button" role="tab" data-pane="share" aria-selected="false">跨产品共享</button>',
    '  </div>',
    '  <div class="omm-body">',
    '    <div class="omm-pane active" data-pane="save">',
    '      <div class="omm-scope" id="omm-save-scope"></div>',
    '      <label class="omm-label" for="omm-path">保存 / 快照目录</label>',
    '      <input class="omm-input" id="omm-path" spellcheck="false" autocomplete="off" />',
    '      <div class="omm-note" id="omm-path-note"></div>',
    '      <div class="omm-row"><label><input type="radio" name="omm-mode" value="versioned" /> 每次保存加时间后缀（保留所有版本）</label></div>',
    '      <div class="omm-row"><label><input type="radio" name="omm-mode" value="overwrite" /> 覆盖同名文件</label></div>',
    '      <div class="omm-row"><label title="每次保存文件时，额外记录一份应用状态，用于以后回滚"><input type="checkbox" id="omm-auto" /> 保存时自动记录历史快照</label></div>',
    '      <div class="omm-row"><label title="保存后把文件放进共享空间，其它产品可以直接取用"><input type="checkbox" id="omm-auto-share" /> 保存后自动放入共享空间</label></div>',
    '      <div class="omm-help">保存的是<b>文件本身</b>；勾选自动快照后，每次保存还会记录一份<b>应用状态</b>（本地存储、会话存储与 IndexedDB），供以后恢复。快照不含磁盘文件，恢复时会覆盖该应用当前的数据。</div>',
    '      <div class="omm-row"><label><input type="checkbox" id="omm-all" /> 以上路径与保存方式应用到所有产品</label></div>',
    '      <div class="omm-row"><button class="omm-primary" id="omm-save-config" type="button">保存设置</button>',
    '        <button class="omm-secondary" id="omm-open-folder" type="button">打开文件夹</button></div>',
    '      <div class="omm-section">',
    '        <label class="omm-label" for="omm-share-path">共享空间目录（全局）</label>',
    '        <input class="omm-input" id="omm-share-path" spellcheck="false" autocomplete="off" />',
    '        <div class="omm-note" id="omm-share-note"></div>',
    '        <div class="omm-row"><button class="omm-secondary" id="omm-save-share-path" type="button">保存并迁移共享目录</button></div>',
    '      </div>',
    '      <div class="omm-note">文件与快照都会写进上面的目录。</div>',
    '    </div>',
    '    <div class="omm-pane" data-pane="archive">',
    '      <div class="omm-lead">每个产品自己的完整历史：磁盘文件 + 可回滚的状态快照。工作台里可切换查看所有产品；只有共享出去的副本才会进入「跨产品共享」。</div>',
    '      <div class="omm-row"><button class="omm-primary" id="omm-snap-now" type="button" title="记录当前应用此刻的本地数据">立即创建快照</button>',
    '        <label id="omm-all-label"><input type="checkbox" id="omm-all-snaps" /> 显示所有产品</label>',
    '        <button class="omm-secondary" id="omm-refresh-archive" type="button">刷新</button></div>',
    '      <div class="omm-scope" id="omm-archive-scope"></div>',
    '      <div class="omm-search" id="omm-search-wrap"><input class="omm-input" id="omm-search" type="search" placeholder="搜索存档：名称、应用或扩展名…" autocomplete="off" /><button id="omm-search-clear" type="button" aria-label="清空搜索">×</button></div>',
    '      <div class="omm-chips" role="group" aria-label="按类型筛选">',
    '        <button type="button" data-kind="all" aria-pressed="true">全部</button>',
    '        <button type="button" data-kind="file" aria-pressed="false">文档</button>',
    '        <button type="button" data-kind="snapshot" aria-pressed="false">快照</button>',
    '      </div>',
    '      <div class="omm-help">快照记录的是<b>应用状态</b>：本地存储、会话存储与 IndexedDB 数据，可恢复到任意时间点；文档是磁盘上的文件，可在对应应用中重新打开。点快照右侧的 ⓘ 可查看它具体包含什么。</div>',
    '      <div class="omm-list" id="omm-archive-list"><div class="omm-empty">读取中…</div></div>',
    '      <div class="omm-foot" id="omm-archive-foot"></div>',
    '    </div>',
    '    <div class="omm-pane" data-pane="share">',
    '      <div id="omm-share-root"></div>',
    '    </div>',
    '  </div>',
    '</section>',
    '<div class="omm-toast" id="omm-toast" role="status"></div>',
  ].join('')

  /* ------------------------------------------------------------ mount + UI */

  function mount() {
    if (document.getElementById('omm-desktop-host')) return
    model.shell = isHubDocument() ? 'hub' : 'app'
    var host = document.createElement('div')
    host.id = 'omm-desktop-host'
    host.style.cssText = 'position:fixed;inset:0;z-index:2147482000;pointer-events:none'
    if (model.shell === 'hub') host.setAttribute('data-shell', 'hub')
    if (ENV.embedded) host.setAttribute('data-embedded', '1')
    var shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>' + PANEL_VARS + PANEL_CSS + '</style>' + PANEL_HTML
    model.shadow = shadow
    model.host = host
    document.documentElement.appendChild(host)
    bindUi()
  }

  function bindUi() {
    byId('omm-open').addEventListener('click', openPanel)
    byId('omm-close').addEventListener('click', closePanel)
    model.shadow.querySelectorAll('.omm-tabs button').forEach(function (button) {
      button.addEventListener('click', function () { setPane(button.dataset.pane) })
    })

    byId('omm-save-config').addEventListener('click', saveSettings)
    byId('omm-open-folder').addEventListener('click', function () {
      var app = effectiveApp()
      if (!app) {
        toast('请先打开一个应用', 'error')
        return
      }
      apiPost('/open', { app: app }).then(function (data) {
        toast('已打开：' + data.path)
      }).catch(function (err) {
        toast('打开失败：' + (err && err.message ? err.message : err), 'error')
      })
    })
    byId('omm-save-share-path').addEventListener('click', saveSharePath)
    byId('omm-snap-now').addEventListener('click', function () {
      createSnapshot().catch(function () {})
    })
    byId('omm-refresh-archive').addEventListener('click', function () { loadArchive() })
    byId('omm-all-snaps').addEventListener('change', function () {
      model.scope.mode = byId('omm-all-snaps').checked ? 'all' : 'app'
      renderScope()
      loadArchive()
    })
    byId('omm-all').addEventListener('change', renderScope)

    var search = byId('omm-search')
    var searchWrap = byId('omm-search-wrap')
    function applyQuery() {
      model.filters.query = search.value || ''
      searchWrap.classList.toggle('has-value', !!model.filters.query)
      scheduleContentSearch()
      renderArchive()
    }
    search.addEventListener('input', applyQuery)
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && search.value) {
        event.stopPropagation()
        search.value = ''
        applyQuery()
      }
    })
    byId('omm-search-clear').addEventListener('click', function () {
      search.value = ''
      applyQuery()
      search.focus()
    })
    model.shadow.querySelectorAll('.omm-chips button').forEach(function (button) {
      button.addEventListener('click', function () {
        model.filters.kind = button.dataset.kind || 'all'
        model.shadow.querySelectorAll('.omm-chips button').forEach(function (other) {
          other.setAttribute('aria-pressed', other === button ? 'true' : 'false')
        })
        renderArchive()
      })
    })

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closePanel()
    })
    /* The floating panel closes on any outside click — in the hub too.  The
       toggle button and the OMM-ZEN UI layer are excluded so a click on them
       does not close the panel right before their own handler opens/uses it. */
    document.addEventListener('pointerdown', function (event) {
      var panel = byId('omm-panel')
      if (!panel || !panel.classList.contains('open')) return
      var path = event.composedPath ? event.composedPath() : [event.target]
      if (path.indexOf(panel) >= 0) return
      if (path.indexOf(byId('omm-open')) >= 0) return
      for (var i = 0; i < path.length; i++) {
        var node = path[i]
        if (!node || !node.closest) continue
        if (node.id === 'omm-ui-host' || node.closest('[data-omm-archive-toggle], [data-omm-ui-layer]')) return
      }
      closePanel()
    }, true)

    if (isHub()) {
      window.addEventListener('omm:archive', function (event) {
        var action = event && event.detail ? event.detail.action : ''
        var panel = byId('omm-panel')
        if (action === 'toggle') {
          if (panel && panel.classList.contains('open')) closePanel()
          else openPanel()
        } else if (action === 'open') {
          openPanel()
          var pane = event.detail.pane
          if (pane) {
            setTimeout(function () { setPane(pane) }, 0)
          }
        } else if (action === 'close') {
          closePanel()
        }
      })
      window.addEventListener('omm:focus-app', function (event) {
        setFocusedApp(event && event.detail ? event.detail : null)
      })
      window.addEventListener('omm:focus-request', function () {
        if (window.__ommFocusedApp) setFocusedApp(window.__ommFocusedApp)
      })
      window.addEventListener('omm:archive-refresh', function () {
        if (model.open) loadArchive()
      })
      if (window.__ommFocusedApp) setFocusedApp(window.__ommFocusedApp)
    }

    if (ENV.embedded) {
      try {
        window.parent.postMessage({ type: 'omm:ready', app: ENV.appId }, '*')
      } catch (e) {
        /* ignore */
      }
      window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return
        var data = event.data
        if (!data || !data.type) return
        if (data.type === 'omm:create-snapshot') onSnapshotRequest(data)
        else if (data.type === 'omm:restore-snapshot') onRestoreRequest(data)
        else if (data.type === 'omm:theme') { setPanelTheme(data.theme); applyShellAppearance(data) }
        else if (data.type === 'omm:state-info') onStateInfoRequest(data)
      })
    }
  }

  var pendingStateInfo = {}

  function requestStateInfo(app) {
    return new Promise(function (resolve, reject) {
      if (!isHub()) {
        liveStateInfo().then(resolve, reject)
        return
      }
      var token = 'si' + Date.now() + Math.random().toString(16).slice(2, 6)
      pendingStateInfo[token] = { resolve: resolve, reject: reject }
      window.dispatchEvent(
        new CustomEvent('omm:state-info-request', { detail: { app: app, token: token } })
      )
      setTimeout(function () {
        if (pendingStateInfo[token]) {
          delete pendingStateInfo[token]
          reject(new Error('应用没有响应，请先打开该产品'))
        }
      }, 8000)
    })
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || !data.type) return
    if (data.type === 'omm:state-info-done' && data.token && pendingStateInfo[data.token]) {
      var pending = pendingStateInfo[data.token]
      delete pendingStateInfo[data.token]
      if (data.info) pending.resolve(data.info)
      else pending.reject(new Error('无法读取应用状态'))
    }
  })

  window.addEventListener('omm:state-info-result', function (event) {
    var detail = event && event.detail
    if (!detail || !detail.token || !pendingStateInfo[detail.token]) return
    var pending = pendingStateInfo[detail.token]
    delete pendingStateInfo[detail.token]
    pending.reject(new Error(detail.error || '无法读取应用状态'))
  })

  function formatCounts(info) {
    if (!info) return '—'
    return (
      '本地存储 ' + (info.localStorage || 0) + ' 项 · 会话 ' + (info.sessionStorage || 0) +
      ' 项 · IndexedDB ' + (info.indexedDB || 0) + ' 库 ' + (info.records || 0) + ' 条'
    )
  }

  function setPanelTheme(theme) {
    model.theme = theme === 'dark' ? 'dark' : 'light'
    if (model.host) model.host.classList.toggle('omm-dark', model.theme === 'dark')
  }

  /* Embedded products have no shell stylesheet, so mirror the hub's palette
     onto the shadow host. Custom properties then cascade into the panel. */
  function applyShellAppearance(data) {
    if (!model.host || !data) return
    var map = {
      '--accent': data.accent,
      '--accent-soft': data.accentSoft,
      '--accent-wash': data.accentWash,
      '--accent-line': data.accentLine,
      '--accent-contrast': data.accentContrast,
      '--radius': (Number(data.radius) || 0) + 'px'
    }
    Object.keys(map).forEach(function (key) {
      if (map[key] != null) model.host.style.setProperty(key, String(map[key]))
    })
  }

  /* Live counters used by the archive panel's snapshot compare feature. */
  function liveStateInfo() {
    var info = { localStorage: 0, sessionStorage: 0, indexedDB: 0, records: 0 }
    try {
      info.localStorage = localStorage.length
    } catch (e) { /* private mode */ }
    try {
      info.sessionStorage = sessionStorage.length
    } catch (e) { /* ignore */ }
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') {
      return Promise.resolve(info)
    }
    return indexedDB.databases().then(function (databases) {
      var names = (databases || [])
        .map(function (item) { return item && item.name })
        .filter(Boolean)
      info.indexedDB = names.length
      return Promise.all(
        names.map(function (name) {
          return new Promise(function (resolve) {
            var settled = false
            var timer = setTimeout(function () { finish(0) }, 1500)
            function finish(total) {
              if (settled) return
              settled = true
              clearTimeout(timer)
              info.records += total || 0
              resolve()
            }
            try {
              var open = indexedDB.open(name)
              open.onsuccess = function () {
                var db = open.result
                var stores = Array.prototype.slice.call(db.objectStoreNames || [])
                if (!stores.length) {
                  db.close()
                  return finish(0)
                }
                var remaining = stores.length
                var counted = 0
                var settle = function () {
                  db.close()
                  finish(counted)
                }
                stores.forEach(function (storeName) {
                  try {
                    var req = db.transaction(storeName, 'readonly').objectStore(storeName).count()
                    req.onsuccess = function () {
                      counted += req.result || 0
                      remaining -= 1
                      if (!remaining) settle()
                    }
                    req.onerror = function () {
                      remaining -= 1
                      if (!remaining) settle()
                    }
                  } catch (e) {
                    remaining -= 1
                    if (!remaining) settle()
                  }
                })
              }
              open.onerror = function () { finish(0) }
            } catch (e) {
              finish(0)
            }
          })
        })
      ).then(function () { return info })
    }).catch(function () { return info })
  }

  function onStateInfoRequest(data) {
    var token = data && data.token
    liveStateInfo().then(function (info) {
      try {
        window.parent.postMessage(
          { type: 'omm:state-info-done', token: token, app: ENV.appId, info: info },
          '*'
        )
      } catch (e) { /* ignore */ }
    })
  }

  function setPane(name) {
    model.pane = name
    model.shadow.querySelectorAll('.omm-tabs button').forEach(function (button) {
      button.setAttribute('aria-selected', button.dataset.pane === name ? 'true' : 'false')
    })
    model.shadow.querySelectorAll('.omm-pane').forEach(function (pane) {
      pane.classList.toggle('active', pane.dataset.pane === name)
    })
    if (name === 'archive') {
      renderScope()
      loadArchive()
    } else if (name === 'share') {
      mountShare()
    } else {
      refreshConfig()
    }
  }

  function mountShare() {
    var root = byId('omm-share-root')
    if (!root) return
    if (!window.OMMShare || !window.OMMShare.mountPanel) {
      root.innerHTML = '<div class="omm-empty">共享模块未加载（omm-share.js）。</div>'
      return
    }
    window.OMMShare.mountPanel(root, { isHub: isHub(), toast: toast })
  }

  function openPanel() {
    var panel = byId('omm-panel')
    if (!panel) return
    model.open = true
    panel.classList.add('open')
    if (isHub()) {
      if (window.__ommFocusedApp) setFocusedApp(window.__ommFocusedApp, true)
      bridgeDispatch('omm:focus-request')
    }
    setPane('save')
    loadArchive()
  }

  function closePanel() {
    var panel = byId('omm-panel')
    model.open = false
    if (panel) panel.classList.remove('open')
  }

  /* ------------------------------------------------------------- rendering */

  function renderScope() {
    if (!model.shadow) return
    var app = effectiveApp()
    var name = effectiveAppName()
    var all = scopeShowsAll()
    var box = byId('omm-all-snaps')
    var label = byId('omm-all-label')
    var scope = byId('omm-archive-scope')
    var saveScope = byId('omm-save-scope')
    var saveAll = byId('omm-all')

    if (box) {
      box.checked = all
      box.disabled = !!(isHub() && !app)
      if (label) {
        label.dataset.disabled = box.disabled ? '1' : '0'
        label.title = box.disabled
          ? '还没有打开的应用；打开一个产品后即可只查看它的存档'
          : all
            ? '当前显示所有产品的存档，取消勾选只看当前应用'
            : '只显示当前应用的存档，勾选后查看所有产品'
      }
    }
    if (saveAll) saveAll.disabled = !!(isHub() && !app)

    if (scope) {
      if (!app) {
        scope.innerHTML = '未打开应用 · 显示<b>所有产品</b>的存档'
      } else if (all) {
        scope.innerHTML = '当前应用：<b>' + escapeHtml(name) + '</b> · 显示所有产品的存档'
      } else {
        scope.innerHTML = '当前应用：<b>' + escapeHtml(name) + '</b> · 仅显示该应用的存档'
      }
    }
    if (saveScope) {
      if (!app) saveScope.innerHTML = '未打开应用 · 打开一个产品后可调整它的保存设置'
      else saveScope.innerHTML = '设置对象：<b>' + escapeHtml(name) + '</b>'
    }
  }

  function renderConfig() {
    if (!model.shadow) return
    var locked = isHub() && !effectiveApp()
    var path = byId('omm-path')
    var note = byId('omm-path-note')
    var auto = byId('omm-auto')
    var autoShare = byId('omm-auto-share')
    var sharePath = byId('omm-share-path')
    var shareNote = byId('omm-share-note')
    var save = byId('omm-save-config')
    var folder = byId('omm-open-folder')
    if (path) {
      path.disabled = locked
      path.value = locked ? '' : model.config.path || model.config.defaultPath || ''
    }
    if (note) {
      note.textContent = locked
        ? '打开一个应用后即可设置它的保存路径'
        : model.config.path
          ? '当前路径：' + model.config.path
          : ''
    }
    model.shadow.querySelectorAll('input[name="omm-mode"]').forEach(function (input) {
      input.disabled = locked
      input.checked = input.value === model.config.mode
    })
    if (auto) {
      auto.disabled = locked
      auto.checked = !!model.config.autoSnapshot
    }
    if (autoShare) {
      autoShare.disabled = locked
      autoShare.checked = !!model.config.autoShare
    }
    if (sharePath) {
      sharePath.value = model.config.sharePath || ''
    }
    if (shareNote) {
      shareNote.textContent = model.config.sharePath
        ? '当前：' + model.config.sharePath
        : '当前使用默认目录（与 shared.json 同级）。修改后会把全部共享内容迁移过去。'
    }
    if (save) save.disabled = locked
    if (folder) folder.disabled = locked
    renderScope()
  }

  function applyConfig(data) {
    if (!data) return
    model.enabled = true
    model.ready = true
    model.config.raw = data.config || model.config.raw
    model.config.path = data.save_path || ''
    model.config.mode = data.mode || model.config.mode
    model.config.autoSnapshot = data.auto_snapshot !== false
    model.config.autoShare = data.auto_share === true
    model.config.sharePath = data.share_path || ''
    model.config.defaultPath =
      data.default_path || ((data.config && data.config.save && data.config.save.path) || '')
  }

  function refreshConfig() {
    var app = effectiveApp()
    if (!model.enabled) return Promise.resolve()
    if (!app) {
      renderConfig()
      return Promise.resolve()
    }
    return apiGet('/config', { app: app }).then(function (data) {
      applyConfig(data)
      renderConfig()
      return data
    }).catch(function () {
      renderConfig()
    })
  }

  /* --------------------------------------------------------------- archive */

  function normalizeEntry(raw) {
    var kind = raw.kind === 'snapshot' ? 'snapshot' : 'file'
    return {
      kind: kind,
      title: String(kind === 'snapshot' ? raw.label || raw.name || '快照' : raw.name || raw.file || '未命名文件'),
      app: raw.app || '',
      appName: raw.app_name || '',
      path: raw.path || '',
      name: raw.name || raw.file || '',
      label: raw.label || '',
      mime: raw.mime || '',
      size: Number(raw.size) || 0,
      time: raw.time || raw.updated || '',
      sort: Number(raw.sort) || 0,
      exists: raw.exists !== false,
      raw: raw,
    }
  }

  function loadArchive() {
    if (!model.enabled || !model.shadow) return
    var app = effectiveApp()
    var all = scopeShowsAll()
    var seq = ++model.seq
    model.loading = true
    model.error = ''
    renderFoot(model.entries.length, model.entries.length)
    var params = { all: all ? '1' : '0' }
    if (app) params.app = app
    apiGet('/archive', params).then(function (data) {
      if (seq !== model.seq) return
      model.loading = false
      model.entries = ((data && data.entries) || []).map(normalizeEntry)
      model.apps = (data && data.apps) || []
      if (isHub() && app && !model.scope.appName) {
        var name = appNameOf(app)
        if (name) model.scope.appName = name
      }
      renderArchive()
    }).catch(function (err) {
      if (seq !== model.seq) return
      model.loading = false
      model.entries = []
      model.error = err && err.message ? err.message : String(err)
      renderArchive()
    })
  }

  function matchesFilters(entry) {
    if (model.filters.kind !== 'all' && entry.kind !== model.filters.kind) return false
    var query = model.filters.query.trim().toLowerCase()
    if (!query) return true
    var haystack = [
      entry.title,
      entry.name,
      entry.label,
      entry.appName,
      entry.app,
      entry.mime,
      entry.path,
    ].join(' ').toLowerCase()
    return haystack.indexOf(query) >= 0
  }

  function archiveEmptyText() {
    var query = model.filters.query.trim()
    if (query) return '没有匹配「' + query + '」的存档。\n换个关键词，或点搜索框右侧的 × 清空。'
    if (model.filters.kind === 'snapshot') return '还没有快照。点“立即创建快照”记录当前应用的状态。'
    if (model.filters.kind === 'file') return '还没有保存过文档。在应用里保存或导出后会出现在这里。'
    if (!scopeShowsAll()) {
      return '「' + (effectiveAppName() || '当前应用') + '」还没有存档。\n勾选“显示所有产品”可以查看其它产品的存档。'
    }
    return '还没有存档。保存文件或点“立即创建快照”即可。'
  }

  var contentSearchTimer = 0

  function scheduleContentSearch() {
    if (contentSearchTimer) clearTimeout(contentSearchTimer)
    contentSearchTimer = setTimeout(runContentSearch, 350)
  }

  function runContentSearch() {
    var query = (model.filters.query || '').trim()
    if (query.length < 2) {
      model.contentMatches = []
      model.contentScanned = 0
      renderArchive()
      return
    }
    var seq = (model.contentSeq = (model.contentSeq || 0) + 1)
    var params = { q: query, limit: '20', all: scopeShowsAll() ? '1' : '0' }
    var app = effectiveApp()
    if (app) params.app = app
    apiGet('/search', params)
      .then(function (data) {
        if (seq !== model.contentSeq) return
        model.contentMatches = (data && data.matches) || []
        model.contentScanned = (data && data.scanned) || 0
        renderArchive()
      })
      .catch(function () {
        if (seq !== model.contentSeq) return
        model.contentMatches = []
        model.contentScanned = 0
      })
  }

  function openMatch(match) {
    if (isHub()) {
      if (!match.app) {
        toast('这条记录没有所属应用，无法打开', 'error')
        return
      }
      bridgeDispatch('omm:load-file', {
        app: match.app,
        path: match.path,
        name: match.name,
        mime: match.mime,
      })
      return
    }
    loadResource({ path: match.path, name: match.name, mime: match.mime })
  }

  function renderContentMatches(list) {
    var matches = model.contentMatches || []
    var box = el('div', 'omm-content-hits')
    var head = el('div', 'omm-content-head')
    head.appendChild(
      el(
        'b',
        '',
        '内容匹配 · ' +
          matches.length +
          ' 个文件' +
          (model.contentScanned ? '（扫描 ' + model.contentScanned + ' 个文本文件）' : '')
      )
    )
    box.appendChild(head)
    if (!matches.length) {
      box.appendChild(el('div', 'omm-content-snippet', '没有文件内容包含这个关键词。'))
      list.appendChild(box)
      return
    }
    matches.forEach(function (match) {
      var row = el('div', 'omm-item omm-hit')
      var main = el('div', 'omm-item-main')
      var head2 = el('div', 'omm-item-head')
      head2.appendChild(el('b', '', match.title || match.name))
      var actions = el('div', 'omm-actions')
      var open = el('button', '', isHub() ? '在应用中打开' : '载入')
      open.type = 'button'
      open.onclick = function () { openMatch(match) }
      actions.appendChild(open)
      var meta = el('div', 'omm-meta')
      meta.appendChild(el('span', 'omm-badge', match.app_name || match.app || ''))
      meta.appendChild(
        document.createTextNode(' · 命中 ' + match.count + ' 处')
      )
      main.appendChild(head2)
      main.appendChild(meta)
      var snippet = el('div', 'omm-content-snippet', match.snippet || '')
      main.appendChild(snippet)
      row.appendChild(main)
      row.appendChild(actions)
      box.appendChild(row)
    })
    list.appendChild(box)
  }

  function renderArchive() {
    var list = byId('omm-archive-list')
    if (!list) return
    var entries = model.entries
    var visible = entries.filter(matchesFilters)
    clear(list)

    var querying = (model.filters.query || '').trim().length >= 2
    if (querying && (model.contentMatches || []).length) {
      renderContentMatches(list)
    }
    if (model.error) {
      list.appendChild(el('div', 'omm-empty', '读取存档失败：' + model.error))
    } else if (!visible.length) {
      list.appendChild(el('div', 'omm-empty', archiveEmptyText()))
    } else {
      visible.forEach(function (entry) {
        list.appendChild(renderEntry(entry))
      })
    }
    renderFoot(entries.length, visible.length)
    renderScope()
  }

  function renderFoot(total, shown) {
    var foot = byId('omm-archive-foot')
    if (!foot) return
    if (model.loading) {
      foot.textContent = '读取中…'
      return
    }
    var files = 0
    var snaps = 0
    model.entries.forEach(function (entry) {
      if (entry.kind === 'snapshot') snaps += 1
      else files += 1
    })
    var filtered = model.filters.query.trim() || model.filters.kind !== 'all'
    var left = filtered ? '匹配 ' + shown + ' / ' + total + ' 条' : '共 ' + total + ' 条'
    foot.innerHTML = '<span>' + left + '</span><span>文档 ' + files + ' · 快照 ' + snaps + '</span>'
  }

  function kindBadge(kind) {
    var badge = el('span', 'omm-kind', kind === 'snapshot' ? '快照' : '文档')
    badge.dataset.kind = kind
    badge.title = kind === 'snapshot'
      ? '应用状态快照：记录本地存储、会话存储与 IndexedDB 中的数据，可恢复'
      : '保存到磁盘的文件：可在对应的应用中重新打开'
    return badge
  }

  function appBadge(entry) {
    var badge = el('span', 'omm-badge', entry.appName || entry.app || '')
    badge.title = '所属应用：' + (entry.appName || entry.app || '未知')
    return badge
  }

  function renderEntry(entry) {
    var row = el('div', 'omm-item')
    var main = el('div', 'omm-item-main')
    var head = el('div', 'omm-item-head')
    var title = el('b', '', entry.title)
    title.title = entry.path || entry.title
    head.appendChild(title)

    var actions = el('div', 'omm-actions')

    if (entry.kind === 'snapshot') {
      var info = el('button', 'omm-info', 'i')
      info.type = 'button'
      info.title = '查看这条快照记录了什么'
      info.setAttribute('aria-label', '查看快照内容')
      info.setAttribute('aria-expanded', 'false')
      info.onclick = function () { toggleDetails(entry, main, info) }
      head.appendChild(info)
    }

    var meta = el('div', 'omm-meta')
    meta.appendChild(kindBadge(entry.kind))
    if (entry.appName || entry.app) meta.appendChild(appBadge(entry))
    meta.appendChild(
      document.createTextNode(
        ' · ' +
          fmtTime(entry.time) +
          ' · ' +
          fmtSize(entry.size) +
          (entry.kind === 'file' && !entry.exists ? ' · 文件已丢失' : '')
      )
    )

    if (entry.kind === 'snapshot') {
      actions.appendChild(restoreButton(entry))
      actions.appendChild(renameButton(entry, main, title))
      actions.appendChild(deleteButton(entry))
    } else {
      actions.appendChild(openButton(entry))
      actions.appendChild(shareButton(entry))
      actions.appendChild(pathButton(entry))
    }

    main.appendChild(head)
    main.appendChild(meta)
    row.appendChild(main)
    row.appendChild(actions)
    if (entry.kind === 'file' && entry.exists) {
      /* Drag the row onto a hub pane to publish + send it to that product. */
      row.draggable = true
      row.addEventListener('dragstart', function (event) {
        try {
          event.dataTransfer.effectAllowed = 'copy'
          event.dataTransfer.setData(
            'application/x-omm-file',
            JSON.stringify({ path: entry.path, name: entry.name, mime: entry.mime || '' })
          )
        } catch (e) { /* ignore */ }
      })
    }
    return row
  }

  function openButton(entry) {
    var button = el('button', '', isHub() ? '在应用中打开' : '载入')
    button.type = 'button'
    button.disabled = !entry.exists
    button.title = !entry.exists
      ? '文件已不在磁盘上'
      : isHub()
        ? '在「' + (entry.appName || entry.app || '对应应用') + '」中打开这份文件'
        : '把这份文件载入当前应用'
    button.onclick = function () {
      if (isHub()) {
        if (!entry.app) {
          toast('这条记录没有所属应用，无法打开', 'error')
          return
        }
        bridgeDispatch('omm:load-file', {
          app: entry.app,
          path: entry.path,
          name: entry.name,
          mime: entry.mime,
        })
        return
      }
      loadResource(entry.raw)
    }
    return button
  }

  function shareButton(entry) {
    var button = el('button', '', '共享')
    button.type = 'button'
    button.title = '放入共享空间，其它产品可以直接取用'
    button.onclick = function () {
      if (!window.OMMShare || !window.OMMShare.enabled) {
        toast('共享空间未就绪，请稍后重试', 'error')
        return
      }
      button.disabled = true
      window.OMMShare.publishFile({
        path: entry.path,
        name: entry.name,
        title: entry.title,
        type: entry.mime,
        replaceKey: 'manual:' + entry.path,
      }).then(function () {
        toast('已放入共享空间，可在“跨产品共享”页发送到其它产品')
      }).catch(function (err) {
        toast('共享失败：' + (err && err.message ? err.message : err), 'error')
      }).finally(function () {
        button.disabled = false
      })
    }
    return button
  }

  function pathButton(entry) {
    var button = el('button', '', '路径')
    button.type = 'button'
    button.title = '复制文件在磁盘上的完整路径'
    button.onclick = function () {
      copyText(entry.path).then(function () {
        toast('已复制路径：' + entry.path)
      }).catch(function () {
        toast('复制失败，请手动选择：' + entry.path, 'error')
      })
    }
    return button
  }

  function restoreButton(entry) {
    var button = el('button')
    button.type = 'button'
    var sameApp = entry.app === effectiveApp()
    button.textContent = sameApp || !isHub() ? '恢复' : '在应用中恢复'
    if (!entry.app && isHub()) {
      button.disabled = true
      button.title = '这条快照没有记录所属应用，无法定位'
    } else if (!isHub() && entry.app && entry.app !== ENV.appId) {
      button.disabled = true
      button.title = '请在该产品中恢复这条快照'
    } else {
      button.title =
        '恢复「' + (entry.appName || appNameOf(entry.app) || entry.app || '当前应用') +
        '」的状态（会覆盖它当前的数据）'
    }
    button.onclick = function () {
      if (button.disabled) return
      var target = entry.appName || appNameOf(entry.app) || entry.app || '当前应用'
      var warning = isHub()
        ? '恢复快照会覆盖「' + target + '」当前的应用数据，确定继续？'
        : '恢复快照会覆盖当前应用数据，确定继续？'
      ask(warning + '\n' + fmtTime(entry.time) + ' · ' + entry.title,
        { title: '恢复快照', ok: '恢复', danger: true }).then(function (ok) {
        if (!ok) return
        if (isHub()) {
          toast('正在「' + target + '」中恢复…')
          bridgeDispatch('omm:restore-snapshot', {
            app: entry.app,
            app_name: target,
            path: entry.path,
            name: entry.name,
            label: entry.label,
          })
          return
        }
        toast('正在恢复快照…')
        apiGet('/snapshot', { app: ENV.appId, path: entry.path }).then(function (data) {
          return applyState(data.snapshot)
        }).catch(function (err) {
          toast('恢复失败：' + (err && err.message ? err.message : err), 'error')
        })
      })
    }
    return button
  }

  function renameButton(entry, main, title) {
    var button = el('button', '', '改名')
    button.type = 'button'
    button.title = '给这条快照起一个好记的名字'
    button.onclick = function () { beginRename(entry, main, title, button) }
    return button
  }

  function deleteButton(entry) {
    var button = el('button', 'danger', '删除')
    button.type = 'button'
    button.title = '永久删除这条快照文件'
    button.onclick = function () {
      ask('删除这个快照文件？此操作不可撤销。\n' + entry.title,
        { title: '删除快照', ok: '删除', danger: true }).then(function (ok) {
        if (!ok) return
        apiPost('/snapshot/delete', { app: entry.app || effectiveApp(), path: entry.path })
          .then(function () {
            toast('快照已删除')
            loadArchive()
          })
          .catch(function (err) {
            toast('删除失败：' + (err && err.message ? err.message : err), 'error')
          })
      })
    }
    return button
  }

  function beginRename(entry, main, titleEl, renameBtn) {
    if (main.querySelector('.omm-rename')) return
    titleEl.style.display = 'none'
    renameBtn.disabled = true

    var wrap = el('div', 'omm-rename')
    var input = el('input')
    input.type = 'text'
    input.value = entry.title
    input.setAttribute('aria-label', '新的快照名称')
    var save = el('button', '', '保存')
    save.type = 'button'
    var cancel = el('button', '', '取消')
    cancel.type = 'button'
    wrap.appendChild(input)
    wrap.appendChild(save)
    wrap.appendChild(cancel)
    var meta = main.querySelector('.omm-meta')
    if (meta) main.insertBefore(wrap, meta)
    else main.appendChild(wrap)
    input.focus()
    input.select()

    function finish() {
      wrap.remove()
      titleEl.style.display = ''
      renameBtn.disabled = false
    }
    function commit() {
      var next = input.value.trim()
      if (!next) {
        toast('名称不能为空', 'error')
        input.focus()
        return
      }
      save.disabled = true
      apiPost('/snapshot/rename', {
        app: entry.app || effectiveApp(),
        path: entry.path,
        label: next,
      }).then(function () {
        toast('已改名为：' + next)
        finish()
        loadArchive()
      }).catch(function (err) {
        save.disabled = false
        toast('改名失败：' + (err && err.message ? err.message : err), 'error')
      })
    }
    save.onclick = commit
    cancel.onclick = finish
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish()
      }
    })
  }

  function toggleDetails(entry, main, button) {
    var existing = main.querySelector('.omm-detail')
    if (existing) {
      existing.remove()
      button.setAttribute('aria-expanded', 'false')
      return
    }
    button.setAttribute('aria-expanded', 'true')
    var box = el('div', 'omm-detail', '读取快照内容…')
    main.appendChild(box)
    apiGet('/snapshot', { app: entry.app || effectiveApp(), path: entry.path })
      .then(function (data) {
        clear(box)
        summarizeSnapshot(data && data.snapshot).forEach(function (pair) {
          var line = el('div')
          line.appendChild(el('span', '', pair[0]))
          line.appendChild(el('span', '', pair[1]))
          box.appendChild(line)
        })
        var compareLine = el('div')
        var compareBtn = el('button', 'omm-compare', '与当前状态对比')
        compareBtn.type = 'button'
        var compareOut = el('span', 'omm-compare-out', '')
        compareBtn.onclick = function () {
          compareBtn.disabled = true
          compareOut.textContent = '读取中…'
          requestStateInfo(entry.app || effectiveApp())
            .then(function (info) {
              compareOut.textContent = '当前：' + formatCounts(info)
              compareBtn.disabled = false
            })
            .catch(function (err) {
              compareOut.textContent = err && err.message ? err.message : '读取失败'
              compareBtn.disabled = false
            })
        }
        compareLine.appendChild(compareBtn)
        compareLine.appendChild(compareOut)
        box.appendChild(compareLine)
      })
      .catch(function (err) {
        box.textContent = '读取失败：' + (err && err.message ? err.message : err)
      })
  }

  /* -------------------------------------------------------------- settings */

  function saveSettings() {
    var app = effectiveApp()
    if (!app) {
      toast('请先打开一个应用，再保存它的设置', 'error')
      return
    }
    var pathInput = byId('omm-path')
    var newPath = pathInput.value.trim()
    var oldPath = model.config.path || model.config.defaultPath || ''
    var scope = byId('omm-all').checked ? 'all' : 'app'

    function commit() {
      var modeInput = model.shadow.querySelector('input[name="omm-mode"]:checked')
      var payload = {
        app: app,
        path: newPath,
        mode: modeInput ? modeInput.value : model.config.mode,
        auto_snapshot: byId('omm-auto').checked,
        auto_share: byId('omm-auto-share').checked,
        scope: scope,
      }
      var button = byId('omm-save-config')
      button.disabled = true
      apiPost('/config', payload).then(function (data) {
        applyConfig(data)
        renderConfig()
        var message = '保存设置已更新：' + model.config.path
        var migrated = data.migrated_save
        if (migrated) {
          message += '\n已迁移 ' + (migrated.moved || 0) + ' 个文件'
          if (migrated.old && migrated.old.length) message += '，旧目录已删除'
          if (migrated.partial) message += '\n旧目录未删除：仍被其它产品使用，或不是 OMM 专用目录'
          if (migrated.leftover && migrated.leftover.length) {
            message += '\n旧目录仍有文件未能删除：' + migrated.leftover.join('；')
          }
        }
        toast(message)
        loadArchive()
      }).catch(function (err) {
        toast('保存设置失败：' + (err && err.message ? err.message : err), 'error')
        renderConfig()
      }).finally(function () {
        button.disabled = false
      })
    }

    if (newPath !== oldPath) {
      var target = newPath || '默认目录'
      var message =
        '修改保存目录会立即迁移内容：\n' +
        oldPath + '\n→ ' + target + '\n\n' +
        (scope === 'all' ? '所有产品' : '当前应用') +
        '的文件与快照都会迁移过去；成功后旧目录（含空文件夹）会被删除。继续？'
      ask(message, { title: '迁移保存目录', ok: '迁移并保存', danger: true }).then(function (ok) {
        if (!ok) { pathInput.value = oldPath; return }
        commit()
      })
      return
    }
    commit()
  }

  function saveSharePath() {
    var input = byId('omm-share-path')
    if (!input) return
    var next = input.value.trim()
    var old = model.config.sharePath || ''
    if (next === old) {
      toast('共享目录未变')
      return
    }
    var message =
      '共享空间的全部内容会立即迁移到：\n' +
      (next || '默认目录') + '\n\n' +
      '成功后旧目录（含空文件夹）会被删除，正在使用的“在应用中打开”等操作不受影响。继续？'

    function commit() {
      var button = byId('omm-save-share-path')
      button.disabled = true
      button.textContent = '迁移中…'
      apiPost('/config', {
        app: effectiveApp() || ENV.appId,
        share_path: next,
      }).then(function (data) {
        applyConfig(data)
        renderConfig()
        var migrated = data.migrated_share
        var text = '共享目录已更新：' + model.config.sharePath
        if (migrated) {
          text += '\n已迁移 ' + (migrated.moved || 0) + ' 个文件'
          if (migrated.old && !migrated.leftover.length) text += '，旧目录已删除'
          if (migrated.leftover && migrated.leftover.length) {
            text += '\n旧目录仍有文件未能删除：' + migrated.leftover.join('；')
          }
        }
        toast(text)
        if (window.OMMShare && window.OMMShare.refresh) window.OMMShare.refresh()
      }).catch(function (err) {
        toast('共享目录迁移失败：' + (err && err.message ? err.message : err), 'error')
        renderConfig()
      }).finally(function () {
        button.disabled = false
        button.textContent = '保存并迁移共享目录'
      })
    }

    ask(message, { title: '迁移共享目录', ok: '迁移', danger: true }).then(function (ok) {
      if (!ok) { input.value = old; return }
      commit()
    })
  }

  /* -------------------------------------------------------------- snapshot */

  function createSnapshot(label) {
    if (!model.enabled) return Promise.reject(new Error('当前不是桌面版'))
    var app = effectiveApp()
    if (!app) {
      toast('请先打开一个应用，再为它创建快照', 'error')
      return Promise.reject(new Error('没有聚焦的应用'))
    }
    var text = label || '手动快照'
    if (isHub()) {
      toast('正在生成历史快照…')
      return requestSnapshotFromProduct(app, text).then(function (result) {
        toast('快照已创建：' + (result.name || text) + '\n' + effectiveAppName())
        if (model.open) loadArchive()
        return result
      }).catch(function (err) {
        toast('快照失败：' + (err && err.message ? err.message : err), 'error')
        throw err
      })
    }
    toast('正在生成历史快照…')
    return captureState(text).then(function (snapshot) {
      return apiPost('/snapshot', { app: app, state: snapshot, label: text })
    }).then(function (result) {
      toast('快照已创建：' + result.name)
      notifyHubSaved()
      if (model.open) loadArchive()
      return result
    }).catch(function (err) {
      toast('快照失败：' + (err && err.message ? err.message : err), 'error')
      throw err
    })
  }

  function requestSnapshotFromProduct(app, label) {
    return new Promise(function (resolve, reject) {
      var settled = false
      var timer = setTimeout(function () {
        if (settled) return
        settled = true
        reject(new Error('应用没有响应，请确认它已完全打开'))
      }, 16000)
      function done(result) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (result && result.ok) resolve(result)
        else reject(new Error((result && result.error) || '快照失败'))
      }
      bridgeDispatch('omm:snapshot-request', { app: app, label: label, done: done })
    })
  }

  function onSnapshotRequest(data) {
    if (!model.enabled) return
    if (data.app && ENV.appId && data.app !== ENV.appId) return
    var token = data.token || ''
    if (token && snapshotTokens[token]) return
    if (token) snapshotTokens[token] = true
    var label = data.label || '手动快照'
    captureState(label).then(function (snapshot) {
      /* Auto snapshots dedup on the data itself, ignoring volatile fields
         (taken_at, label) that change every time. */
      var comparable = null
      try {
        comparable = JSON.stringify({
          localStorage: snapshot.localStorage || {},
          sessionStorage: snapshot.sessionStorage || {},
          indexedDB: snapshot.indexedDB || [],
        })
      } catch (e) { /* ignore */ }
      if (data.dedup && comparable) {
        if (comparable === model.lastAutoState) {
          return { skipped: true, name: '', path: '' }
        }
        model.lastAutoState = comparable
      }
      return apiPost('/snapshot', { app: ENV.appId, state: snapshot, label: label })
    }).then(function (result) {
      try {
        window.parent.postMessage(
          {
            type: 'omm:snapshot-done',
            token: token,
            ok: true,
            skipped: !!(result && result.skipped),
            name: result.name,
            path: result.path,
          },
          '*'
        )
      } catch (e) {
        /* ignore */
      }
      if (result && result.skipped) return result
      if (model.open) loadArchive()
    }).catch(function (err) {
      try {
        window.parent.postMessage(
          {
            type: 'omm:snapshot-done',
            token: token,
            ok: false,
            error: err && err.message ? err.message : String(err),
          },
          '*'
        )
      } catch (e) {
        /* ignore */
      }
    })
  }

  function onRestoreRequest(data) {
    if (!model.enabled || !data.path) return
    if (data.app && ENV.appId && data.app !== ENV.appId) return
    var token = data.token || ''
    if (token && restoreTokens[token]) return
    if (token) {
      restoreTokens[token] = true
      try {
        window.parent.postMessage({ type: 'omm:restore-accepted', token: token }, '*')
      } catch (e) {
        /* ignore */
      }
    }
    apiGet('/snapshot', { app: ENV.appId, path: data.path })
      .then(function (result) { return applyState(result.snapshot) })
      .catch(function (err) {
        toast('恢复失败：' + (err && err.message ? err.message : err), 'error')
      })
  }

  /* ---------------------------------------------------------------- bridge */

  function bridgeDispatch(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail: detail }))
  }

  function setFocusedApp(detail, immediate) {
    if (!isHub()) return
    var app = (detail && detail.app) || ''
    var name = (detail && detail.name) || ''
    model.scope.app = app
    model.scope.appName = name
    renderScope()
    if (!model.open) return
    if (immediate) return
    clearTimeout(focusTimer)
    focusTimer = setTimeout(function () {
      if (!model.open) return
      if (model.pane === 'save' && !isEditing()) refreshConfig()
      loadArchive()
    }, 120)
  }

  function isEditing() {
    if (!model.shadow) return false
    var active = model.shadow.activeElement
    return !!(active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    apiGet('/status').then(function (data) {
      if (!data || !data.desktop) return
      applyConfig(data)
      installHooks()
      mount()
      if (isHub()) {
        if (window.__ommFocusedApp) setFocusedApp(window.__ommFocusedApp, true)
        bridgeDispatch('omm:focus-request')
        renderScope()
        if (effectiveApp()) refreshConfig()
      } else {
        refreshConfig()
      }
      window.dispatchEvent(new CustomEvent('omm-desktop-ready', { detail: { app: ENV.appId } }))
    }).catch(function () {
      /* Public website: no desktop API. Stay completely silent. */
    })
  }

  window.OMMDesktop = {
    app: ENV.appId,
    get enabled() { return model.enabled },
    saveBlob: saveBlob,
    saveText: saveText,
    snapshot: createSnapshot,
    captureState: captureState,
    restore: applyState,
    loadResource: loadResource,
    loadBlob: loadBlob,
    openPanel: openPanel,
    openFolder: function () { return apiPost('/open', { app: effectiveApp() }) },
    config: function () { return apiGet('/config', { app: effectiveApp() }) },
    shared: function () { return apiGet('/shared') },
    setConfig: function (patch) {
      return apiPost('/config', Object.assign({ app: effectiveApp() }, patch || {}))
        .then(function (data) { applyConfig(data); renderConfig(); return data })
    },
    listSnapshots: function (all) {
      return apiGet('/snapshots', { app: effectiveApp(), all: all ? '1' : '0' })
    },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0) })
  } else {
    setTimeout(boot, 0)
  }
})()
