/* OMM-ZEN hub shell.
 *
 * One shell window, one iframe per product. Products keep their own loopback
 * origin, so their localStorage / IndexedDB / sessions stay isolated exactly
 * like the standalone builds. Iframes are positioned over pane bodies instead
 * of being re-parented, which keeps their browsing context alive across tab
 * switches and splits.
 */
(function () {
  'use strict';

  var APP_LIST = [];
  var APP_BY_ID = {};
  var PLUGIN_INFO = [];
  var pluginPanelTab = 'installed';
  var catalogCache = null;
  var catalogError = '';
  var catalogLoading = false;
  var updateInfo = null;
  var updateChecking = false;
  var pluginLoadError = '';
  var PLUGIN_DIR = '';
  var pluginDirEditing = false;
  var APPEARANCE_KEY = 'omm.hub.appearance.v1';
  var PIN_KEY = 'omm.hub.pins.v1';
  var RECENT_KEY = 'omm.hub.recent.v1';
  var WORKSPACE_KEY = 'omm.hub.workspaces.v1';
  var DEFAULT_CUSTOM_HEX = '#FF8FC8';
  var ACCENT_HEX_HINT = '支持 #RGB / #RRGGBB，例如 #FF8FC8；深色主题会自动提亮。';
  var hubAppearance = {
    radius: 0,
    accent: 'amber',
    accentHex: '',
    theme: 'light',
    motion: true,
    topbar: true,
    restore: true,
    sleep: 15,
    snap: 0,
    dockSort: 'fixed',
  };

  /* Single source of truth for the accent palette.  Every tinted surface reads
     the --accent* variables derived from here, so UI colours are never
     hard-coded in the stylesheet.  Young / lively tones were added alongside
     the four original earthy ones. */
  var ACCENTS = [
    { id: 'amber',   name: '琥珀',   light: '#e3a400', dark: '#f2b81c' },
    { id: 'olive',   name: '橄榄',   light: '#7c7f42', dark: '#aab060' },
    { id: 'rust',    name: '赭石',   light: '#b56545', dark: '#dd8e6b' },
    { id: 'blue',    name: '雾蓝',   light: '#5b7692', dark: '#84b0da' },
    { id: 'coral',   name: '珊瑚',   light: '#f2605a', dark: '#ff7d76' },
    { id: 'peach',   name: '蜜桃',   light: '#f2914f', dark: '#ffb57c' },
    { id: 'mint',    name: '薄荷',   light: '#2fb79d', dark: '#55dfc3' },
    { id: 'sky',     name: '天青',   light: '#359be0', dark: '#6cc2ff' },
    { id: 'violet',  name: '紫罗兰', light: '#8a6cf0', dark: '#ac91ff' },
    { id: 'pink',    name: '樱粉',   light: '#f472b6', dark: '#ff9ed2' },
    { id: 'lime',    name: '青柠',   light: '#86c23c', dark: '#aee465' },
    { id: 'indigo',  name: '靛蓝',   light: '#4f5bd5', dark: '#7d89ff' },
  ];

  function normalizeHex(value) {
    var s = String(value == null ? '' : value).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return '';
    return '#' + s.toUpperCase();
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      var n = Math.max(0, Math.min(255, Math.round(v)));
      return ('0' + n.toString(16)).slice(-2);
    }).join('').toUpperCase();
  }

  /* A custom colour only needs one hex value: the dark variant is derived so
     it stays legible on the dark shell without a second input. */
  function accentForDark(hex) {
    var c = hexToRgb(hex);
    return rgbToHex(
      c.r + (255 - c.r) * 0.3,
      c.g + (255 - c.g) * 0.3,
      c.b + (255 - c.b) * 0.3
    );
  }

  function accentById(id) {
    if (id === 'custom') {
      var hex = normalizeHex(hubAppearance.accentHex) || DEFAULT_CUSTOM_HEX;
      return { id: 'custom', name: '自定义', light: hex, dark: accentForDark(hex) };
    }
    for (var i = 0; i < ACCENTS.length; i++) {
      if (ACCENTS[i].id === id) return ACCENTS[i];
    }
    return ACCENTS[0];
  }

  function hexToRgb(hex) {
    var s = String(hex || '').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function accentRgba(hex, alpha) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + alpha + ')';
  }

  function accentContrast(hex) {
    var c = hexToRgb(hex);
    var lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
    return lum > 0.66 ? '#26231f' : '#ffffff';
  }

  /* Publish the whole accent scale as CSS variables.  Both the shell and the
     shadow-DOM archive panel inherit them automatically. */
  function applyAccentPalette() {
    var tone = accentById(hubAppearance.accent);
    var dark = effectiveTheme() === 'dark';
    var base = dark ? tone.dark : tone.light;
    var root = document.documentElement;
    root.style.setProperty('--accent', base);
    root.style.setProperty('--accent-soft', accentRgba(base, dark ? 0.26 : 0.16));
    root.style.setProperty('--accent-wash', accentRgba(base, dark ? 0.13 : 0.08));
    root.style.setProperty('--accent-line', accentRgba(base, dark ? 0.62 : 0.5));
    root.style.setProperty('--accent-glow', accentRgba(base, dark ? 0.34 : 0.24));
    root.style.setProperty('--accent-contrast', accentContrast(base));
  }

  /* Keep the custom hex field in sync without overwriting what the user is
     currently typing. */
  function syncAccentHexControls() {
    var input = document.getElementById('hub-accent-hex');
    var preview = document.getElementById('hub-accent-hex-preview');
    var hex = normalizeHex(hubAppearance.accentHex) || DEFAULT_CUSTOM_HEX;
    if (input && document.activeElement !== input) {
      input.value = hubAppearance.accent === 'custom' ? hex.slice(1) : '';
    }
    if (preview) {
      preview.style.setProperty('--swatch', hex);
      preview.setAttribute('aria-label', '使用这个自定义颜色（' + hex + '）');
    }
  }

  function buildAccentSwatches() {
    var box = document.getElementById('hub-accent-options');
    if (!box || box.dataset.built === '1') return;
    box.dataset.built = '1';
    ACCENTS.concat([{ id: 'custom', name: '自定义颜色', light: '', dark: '' }]).forEach(function (tone) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.hubAccent = tone.id;
      btn.title = tone.id === 'custom' ? '使用自定义的颜色' : tone.name;
      btn.setAttribute('aria-label', tone.id === 'custom' ? '使用自定义的颜色' : '主题色：' + tone.name);
      if (tone.id === 'custom') btn.classList.add('swatch-custom');
      if (tone.light) btn.style.setProperty('--swatch-light', tone.light);
      if (tone.dark) btn.style.setProperty('--swatch-dark', tone.dark);
      box.appendChild(btn);
    });
  }

  function accentBroadcastPayload(theme) {
    var tone = accentById(hubAppearance.accent);
    var dark = (theme || effectiveTheme()) === 'dark';
    var base = dark ? tone.dark : tone.light;
    return {
      theme: dark ? 'dark' : 'light',
      accent: base,
      accentSoft: accentRgba(base, dark ? 0.26 : 0.16),
      accentWash: accentRgba(base, dark ? 0.13 : 0.08),
      accentLine: accentRgba(base, dark ? 0.62 : 0.5),
      accentContrast: accentContrast(base),
      radius: hubAppearance.radius,
    };
  }
  var launcherQuery = '';
  var launcherIndex = 0;
  var launcherComposing = false;
  var launcherPinned = [];
  var launcherRecent = [];
  var closedStack = [];
  var appLastActive = {};
  var appMountedAt = {};
  var errorNotified = {};
  var shareBadges = {};
  var notifications = [];
  var notifyUnread = 0;
  var recentFiles = [];
  var recentFilesAt = 0;
  var workspaces = [];
  var activeWorkspaceId = '';
  var cmdkOpen = false;
  var cmdkItems = [];
  var cmdkIndex = 0;
  var cmdkShares = [];
  var cmdkSharesAt = 0;
  var cmdkSpace = null;
  var cmdkFiltered = [];
  var autoSleepTimer = 0;
  var lastAutoSnapAt = 0;
  var autoSnapBusy = false;
  var lastSnapshotByApp = {};
  var USAGE_KEY = 'omm.hub.usage.v1';
  var usageStats = {};

  function setApps(plugins) {
    var valid = [];
    var map = {};
    (plugins || []).forEach(function (item) {
      if (!item || !item.id || !item.name) return;
      map[item.id] = item;
      valid.push(item);
    });
    APP_LIST = valid.sort(function (a, b) {
      return (a.order || 999) - (b.order || 999);
    });
    APP_BY_ID = map;
    PLUGIN_INFO = APP_LIST;
    pruneMissingPlugins();
    paneEls.forEach(function (el) {
      var holder = el.querySelector('.pane-placeholder');
      if (holder) holder.dataset.mode = '';
    });
  }

  function pruneMissingPlugins() {
    if (!state || !state.panes) return;
    var open = [];
    state.open.forEach(function (id) {
      if (APP_BY_ID[id]) open.push(id);
      else destroyFrame(id);
    });
    state.open = open;
    Object.keys(state.panes).forEach(function (paneId) {
      var app = state.panes[paneId];
      if (app && !APP_BY_ID[app]) state.panes[paneId] = null;
    });
    if (state.maximized && !APP_BY_ID[paneApp(state.maximized)]) state.maximized = null;
  }

  function appOf(appId) {
    return APP_BY_ID[appId] || null;
  }

  var STORAGE_KEY = 'omm.hub.workspace.v1';
  var SPLIT = 4;
  var HEAD = 32;
  var MIN_W = 240;
  var MIN_H = 170;

  var ICON_SPLIT_V =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16"/><path d="M12 4v16"/></svg>';
  var ICON_SPLIT_H =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16"/><path d="M3 12h18"/></svg>';

  var els = {};
  var state = defaultState();
  var paneEls = new Map();
  var splitterEls = new Map();
  var frames = new Map();
  var appStatus = {}; /* idle | loading | ready | error */
  var appErrors = {};
  var appUrls = {};
  var ensurePromises = {};
  var loadTimers = {};
  var layoutRects = new Map();
  var splitRegions = new Map();
  var paneSeq = 1;
  var splitSeq = 0;
  var saveTimer = 0;
  var layoutRaf = 0;
  var dragApp = null;
  var shareDrag = null; /* { kind: 'item'|'file', data } while dragging share/archive rows */
  var dragTarget = null;
  var resizeState = null;
  var launcherOpen = false;

  function defaultState() {
    return {
      open: [],
      tree: { type: 'leaf', id: 'p1' },
      panes: { p1: null },
      focused: 'p1',
      dock: true,
      maximized: null,
    };
  }

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* All shell confirmations go through the OMM-ZEN UI kit instead of the
     browser's native dialog. Returns Promise<boolean>. */
  function ommConfirm(message, opts) {
    if (window.OMMUI && window.OMMUI.confirm) return window.OMMUI.confirm(message, opts);
    return Promise.resolve(window.confirm(message));
  }

  function appIconHTML(app) {
    if (app && window.OMMIcon) return window.OMMIcon(app.id, app.glyph);
    return esc((app && app.glyph) || '?');
  }

  function appIconClass(app) {
    return app && window.OMMIconClass ? window.OMMIconClass(app.id) : '';
  }

  function paneApp(paneId) {
    return state.panes[paneId] || null;
  }

  function findPaneByApp(appId) {
    for (var paneId in state.panes) {
      if (state.panes[paneId] === appId) return paneId;
    }
    return null;
  }

  function leafIds(node, out) {
    out = out || [];
    if (!node) return out;
    if (node.type === 'leaf') {
      out.push(node.id);
    } else {
      leafIds(node.a, out);
      leafIds(node.b, out);
    }
    return out;
  }

  function firstLeafId() {
    var ids = leafIds(state.tree);
    return ids[0] || null;
  }

  function findLeafNode(paneId) {
    var found = null;
    (function walk(node) {
      if (!node || found) return;
      if (node.type === 'leaf') {
        if (node.id === paneId) found = node;
      } else {
        walk(node.a);
        walk(node.b);
      }
    })(state.tree);
    return found;
  }

  function newPaneId() {
    do {
      paneSeq += 1;
    } while (state.panes['p' + paneSeq]);
    return 'p' + paneSeq;
  }

  function ensureSplitKeys(node) {
    if (!node || node.type !== 'split') return;
    if (!node.key) node.key = 's' + ++splitSeq;
    ensureSplitKeys(node.a);
    ensureSplitKeys(node.b);
  }

  function syncSplitSeq(node) {
    if (!node) return;
    if (node.type === 'split') {
      var match = String(node.key || '').match(/^s(\d+)$/);
      if (match) splitSeq = Math.max(splitSeq, Number(match[1]));
      syncSplitSeq(node.a);
      syncSplitSeq(node.b);
    }
  }

  function findSplitByKey(key) {
    var found = null;
    (function walk(node) {
      if (!node || found) return;
      if (node.type === 'split') {
        if (node.key === key) {
          found = node;
          return;
        }
        walk(node.a);
        walk(node.b);
      }
    })(state.tree);
    return found;
  }

  function validTree(node, seen) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'leaf') {
      if (typeof node.id !== 'string' || !node.id || seen[node.id]) return false;
      seen[node.id] = true;
      return true;
    }
    if (node.type !== 'split') return false;
    if (node.dir !== 'v' && node.dir !== 'h') return false;
    if (typeof node.ratio !== 'number' || !isFinite(node.ratio)) return false;
    return validTree(node.a, seen) && validTree(node.b, seen);
  }

  /* ------------------------------------------------------------- persistence */

  function loadState() {
    if (hubAppearance.restore === false) {
      state = defaultState();
      state.dock = storedDockVisible();
      return;
    }
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      raw = null;
    }
    if (!raw) {
      state = defaultState();
      return;
    }
    try {
      var data = JSON.parse(raw);
      var open = [];
      if (data && Array.isArray(data.open)) {
        data.open.forEach(function (id) {
          if (APP_BY_ID[id] && open.indexOf(id) < 0) open.push(id);
        });
      }
      var seen = {};
      var tree = data && data.tree;
      if (!validTree(tree, seen)) {
        tree = { type: 'leaf', id: 'p1' };
        seen = { p1: true };
      }
      var panes = {};
      var ids = leafIds(tree);
      var used = {};
      ids.forEach(function (id) {
        var app = data && data.panes ? data.panes[id] : null;
        if (app && APP_BY_ID[app] && !used[app]) {
          panes[id] = app;
          used[app] = true;
          if (open.indexOf(app) < 0) open.push(app);
        } else {
          panes[id] = null;
        }
      });
      var focused = data && data.focused;
      if (ids.indexOf(focused) < 0) focused = ids[0];
      state = {
        open: open,
        tree: tree,
        panes: panes,
        focused: focused,
        dock: !data || data.dock !== false,
        maximized: null,
      };
      paneSeq = 1;
      ids.forEach(function (id) {
        var n = parseInt(String(id).replace(/^p/, ''), 10);
        if (isFinite(n) && n > paneSeq) paneSeq = n;
      });
      ensureSplitKeys(state.tree);
      syncSplitSeq(state.tree);
    } catch (e) {
      state = defaultState();
    }
  }

  function storedDockVisible() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return true;
      var data = JSON.parse(raw);
      return !data || data.dock !== false;
    } catch (e) {
      return true;
    }
  }

  function save() {
    if (saveTimer) return;
    saveTimer = window.setTimeout(function () {
      saveTimer = 0;
      saveNow();
    }, 180);
  }

  function saveNow() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          open: state.open,
          tree: state.tree,
          panes: state.panes,
          focused: state.focused,
          dock: state.dock,
        })
      );
    } catch (e) {
      /* ignore quota / private mode */
    }
  }

  /* ------------------------------------------------------------------- init */

  function init() {
    els.app = document.getElementById('app');
    els.topbar = document.getElementById('topbar');
    els.brand = document.getElementById('brand');
    els.tabAdd = document.getElementById('tab-add');
    els.tabs = document.getElementById('tabs');
    els.workspace = document.getElementById('workspace');
    els.paneLayer = document.getElementById('pane-layer');
    els.iframeLayer = document.getElementById('iframe-layer');
    els.splitterLayer = document.getElementById('splitter-layer');
    els.dropLayer = document.getElementById('drop-layer');
    els.dropHint = document.getElementById('drop-hint');
    els.dock = document.getElementById('dock');
    els.launcher = document.getElementById('launcher');
    els.layoutMenu = document.getElementById('layout-menu');
    els.ctxMenu = document.getElementById('ctx-menu');
    els.notifyPanel = document.getElementById('notify-panel');
    els.tabsMore = document.getElementById('tabs-more');
    els.notifyList = document.getElementById('notify-list');
    els.cmdk = document.getElementById('command-palette');
    els.cmdkInput = document.getElementById('cmdk-input');
    els.cmdkList = document.getElementById('cmdk-list');
    els.toast = document.getElementById('toast');
    els.pluginPanel = document.getElementById('plugin-panel');
    els.ppBody = document.getElementById('pp-body');
    els.ppTitle = document.getElementById('pp-title');
    els.ppStatus = document.getElementById('pp-status');
    els.hubSettings = document.getElementById('hub-settings');

    loadHubAppearance();
    loadLauncherPrefs();
    loadWorkspaces();
    loadUsage();
    applyHubAppearance();
    bindHubSettings();
    initWorkspaceMenu();

    ensureSplitKeys(state.tree);
    state.dock = storedDockVisible();
    applyDockState();
    bindEvents();
    renderAll();

    loadPlugins(true).then(function () { loadRecentFiles(); });
    if (autoSleepTimer) window.clearInterval(autoSleepTimer);
    autoSleepTimer = window.setInterval(function () {
      autoSleepTick();
      autoSnapTick();
      usageTick();
    }, 60000);

    if (window.ResizeObserver) {
      new ResizeObserver(scheduleLayout).observe(els.workspace);
    }
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('beforeunload', saveNow);
    window.addEventListener('pagehide', saveNow);
    lockShellScroll();
  }

  /* The shell is a fixed layout: it must never scroll.  An embedded page
     calling scrollIntoView() can otherwise drag the whole document (the
     top bar and the tab strip slide out of sight and blank space appears
     below), because overflow:hidden containers are still scrollable
     programmatically.  Keep the document pinned at the origin. */
  function lockShellScroll() {
    function pin() {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      var app = els.app;
      if (app && (app.scrollTop || app.scrollLeft)) {
        app.scrollTop = 0;
        app.scrollLeft = 0;
      }
    }
    window.addEventListener('scroll', pin, { passive: true });
    document.addEventListener('scroll', pin, { passive: true, capture: true });
    pin();
  }

  function loadPlugins(restore) {
    return fetch('/api/plugins', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('插件列表加载失败（' + response.status + '）');
        return response.json();
      })
      .then(function (data) {
        pluginLoadError = '';
        PLUGIN_DIR = data.plugin_dir || '';
        if (els.pluginPanel) els.pluginPanel.dataset.dir = PLUGIN_DIR;
        setApps(data.plugins || []);
        buildDock();
        if (restore) {
          loadState();
          ensureSplitKeys(state.tree);
          applyDockState();
          renderAll();
          mountVisible();
          save();
        } else {
          renderAll();
          save();
        }
        return data;
      })
      .catch(function (error) {
        pluginLoadError = error && error.message ? error.message : '插件列表加载失败';
        renderAll();
        toast(pluginLoadError);
      });
  }

  function mountVisible() {
    Object.keys(state.panes).forEach(function (paneId) {
      var app = state.panes[paneId];
      if (app) mountApp(app);
    });
  }

  /* ----------------------------------------------------------------- chrome */

  function renderAll() {
    renderTabs();
    renderDock();
    if (launcherOpen) renderLauncher();
    updateToolState();
    renderLayout();
  }

  function renderTabs() {
    if (!els.tabs) return;
    var activeApp = paneApp(state.focused);
    broadcastFocus(activeApp);
    if (!state.open.length) {
      els.tabs.innerHTML = '';
      return;
    }
    var activeApp = paneApp(state.focused);
    els.tabs.innerHTML = state.open
      .map(function (appId) {
        var app = appOf(appId);
        if (!app) return '';
        var pane = findPaneByApp(appId);
        var active = pane && pane === state.focused;
        var cls = 'tab';
        if (active) cls += ' active';
        if (!pane) cls += ' hidden-app';
        else if (!active) cls += ' visible-elsewhere';
        if (appStatus[appId] === 'sleeping') cls += ' sleeping';
        return (
          '<button class="' +
          cls +
          '" type="button" role="tab" draggable="true" data-app="' +
          esc(appId) +
          '" title="' +
          esc(app.name) +
          '">' +
          '<span class="tab-glyph' + appIconClass(app) + '">' +
          appIconHTML(app) +
          '</span>' +
          '<span class="tab-label">' +
          esc(app.name) +
          '</span>' +
          (shareBadges[appId]
            ? '<span class="tab-dot" title="有共享消息"></span>'
            : '') +
          '<span class="tab-close" data-close="' +
          esc(appId) +
          '" role="button" title="关闭">×</span>' +
          '</button>'
        );
      })
      .join('');
    /* Keep the active tab visible without scrollIntoView(): that would also
       scroll the shell document and drag the whole layout. */
    var active = els.tabs.querySelector('.tab.active');
    if (active && els.tabs.scrollWidth > els.tabs.clientWidth) {
      var ar = active.getBoundingClientRect();
      var tr = els.tabs.getBoundingClientRect();
      if (ar.left < tr.left) {
        els.tabs.scrollLeft -= tr.left - ar.left;
      } else if (ar.right > tr.right) {
        els.tabs.scrollLeft += ar.right - tr.right;
      }
    }
    updateTabsOverflow();
  }

  /* -------------------------------------------------- tabs overflow menu */
  function updateTabsOverflow() {
    var button = document.getElementById('tabs-overflow');
    if (!button) return;
    var overflowing =
      state.open.length > 1 &&
      els.tabs.scrollWidth > els.tabs.clientWidth + 2;
    button.hidden = !overflowing;
    if (!overflowing) {
      var menu = document.getElementById('tabs-more');
      if (menu) menu.hidden = true;
    }
  }

  function renderTabsMore() {
    var menu = document.getElementById('tabs-more');
    var button = document.getElementById('tabs-overflow');
    if (!menu || !button) return;
    if (!state.open.length) {
      menu.hidden = true;
      return;
    }
    var activeApp = paneApp(state.focused);
    menu.innerHTML = state.open
      .map(function (appId) {
        var app = appOf(appId);
        if (!app) return '';
        var note = appStatus[appId] === 'sleeping' ? ' · 休眠' : '';
        return (
          '<button class="menu-item" type="button" data-more="' + esc(appId) + '">' +
          '<span class="check">' + (appId === activeApp ? '✓' : '') + '</span>' +
          esc(app.name) +
          '<span class="more-meta">' + note + '</span></button>'
        );
      })
      .join('');
    menu.hidden = false;
    var br = button.getBoundingClientRect();
    var width = menu.offsetWidth || 230;
    menu.style.left = Math.max(8, br.right - width) + 'px';
    menu.style.top = br.bottom + 6 + 'px';
  }

  function toggleTabsMore(force) {
    var menu = document.getElementById('tabs-more');
    if (!menu) return;
    var show = typeof force === 'boolean' ? force : menu.hidden;
    closePopovers();
    if (!show) return;
    renderTabsMore();
  }

  /* ----------------------------------------------- tab drag to reorder */
  var tabReorderIndex = -1;

  function tabInsertIndexFromEvent(event) {
    var tabs = Array.prototype.slice.call(els.tabs.querySelectorAll('.tab[data-app]'));
    for (var i = 0; i < tabs.length; i++) {
      var box = tabs[i].getBoundingClientRect();
      if (event.clientX < box.left + box.width / 2) {
        return state.open.indexOf(tabs[i].dataset.app);
      }
    }
    var last = tabs[tabs.length - 1];
    return last ? state.open.indexOf(last.dataset.app) + 1 : state.open.length;
  }

  function reorderTabs(fromApp, toIndex) {
    var from = state.open.indexOf(fromApp);
    if (from < 0) return;
    if (toIndex > from) toIndex -= 1;
    if (toIndex === from) return;
    state.open.splice(from, 1);
    state.open.splice(Math.max(0, toIndex), 0, fromApp);
    renderTabs();
    renderDock();
    save();
  }

  /* The archive panel listens for this: switching or closing a tab must make
     the list follow the newly focused product immediately. */
  var lastFocusKey = null;
  function broadcastFocus(appId, force) {
    var app = appId ? appOf(appId) : null;
    var detail = { app: appId || '', name: app ? app.name : '' };
    var key = detail.app + '|' + detail.name;
    if (!force && key === lastFocusKey) return;
    lastFocusKey = key;
    window.__ommFocusedApp = detail;
    window.dispatchEvent(new CustomEvent('omm:focus-app', { detail: detail }));
  }

  function whenAppReady(appId, callback) {
    var started = Date.now();
    (function attempt() {
      var frame = frames.get(appId);
      if (frame && frame.contentWindow) {
        if (frame.dataset.ready === '1' || Date.now() - started > 2600) {
          callback(frame);
          return;
        }
      }
      if (Date.now() - started > 20000) {
        callback(null);
        return;
      }
      window.setTimeout(attempt, 150);
    })();
  }

  var pendingSnapshots = {};
  var pendingRestores = {};

  window.addEventListener('omm:snapshot-request', function (event) {
    var detail = event && event.detail ? event.detail : null;
    if (!detail || !detail.done) return;
    var appId = detail.app || paneApp(state.focused);
    if (!appId || !APP_BY_ID[appId]) {
      detail.done({ ok: false, error: '没有可用的应用' });
      return;
    }
    whenAppReady(appId, function (frame) {
      if (!frame) {
        detail.done({ ok: false, error: '应用启动超时' });
        return;
      }
      var token = 's' + Date.now() + Math.random().toString(16).slice(2, 6);
      pendingSnapshots[token] = detail.done;
      var timer = window.setInterval(function () {
        if (!pendingSnapshots[token]) {
          window.clearInterval(timer);
          return;
        }
        try {
          frame.contentWindow.postMessage(
            {
              type: 'omm:create-snapshot',
              token: token,
              app: appId,
              label: detail.label || '手动快照',
              dedup: !!detail.dedup,
            },
            '*'
          );
        } catch (e) {
          /* retry until the timeout */
        }
      }, 900);
      window.setTimeout(function () {
        window.clearInterval(timer);
        var done = pendingSnapshots[token];
        delete pendingSnapshots[token];
        if (done) done({ ok: false, error: '应用没有响应，请稍后重试' });
      }, 12000);
    });
  });

  window.addEventListener('omm:state-info-request', function (event) {
    var detail = event && event.detail ? event.detail : null;
    if (!detail || !detail.token) return;
    var appId = detail.app;
    var frame = appId ? frames.get(appId) : null;
    if (!frame || appStatus[appId] !== 'ready') {
      window.dispatchEvent(
        new CustomEvent('omm:state-info-result', {
          detail: { token: detail.token, error: '应用未运行，请先打开该产品' },
        })
      );
      return;
    }
    try {
      frame.contentWindow.postMessage(
        { type: 'omm:state-info', token: detail.token, app: appId },
        '*'
      );
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent('omm:state-info-result', {
          detail: { token: detail.token, error: '应用没有响应' },
        })
      );
    }
  });

  window.addEventListener('omm:restore-snapshot', function (event) {
    var detail = event && event.detail ? event.detail : null;
    if (!detail || !detail.path) return;
    var appId = detail.app;
    if (!appId || !APP_BY_ID[appId]) {
      toast('找不到这条快照所属的应用');
      return;
    }
    activateApp(appId);
    whenAppReady(appId, function (frame) {
      if (!frame) {
        toast('应用启动超时');
        return;
      }
      var token = 'r' + Date.now() + Math.random().toString(16).slice(2, 6);
      var tries = 0;
      pendingRestores[token] = true;
      function send() {
        tries += 1;
        if (tries > 10) {
          window.clearInterval(timer);
          delete pendingRestores[token];
          toast('恢复超时，请重试');
          return;
        }
        try {
          frame.contentWindow.postMessage(
            {
              type: 'omm:restore-snapshot',
              token: token,
              app: appId,
              path: detail.path,
              name: detail.name,
              label: detail.label,
            },
            '*'
          );
        } catch (e) {
          /* retry */
        }
      }
      var timer = window.setInterval(function () {
        if (!pendingRestores[token]) {
          window.clearInterval(timer);
          return;
        }
        send();
      }, 800);
      send();
    });
  });

  function dockApps() {
    if (hubAppearance.dockSort !== 'usage') return APP_LIST;
    return APP_LIST.slice().sort(function (a, b) {
      return usageScore(b.id) - usageScore(a.id);
    });
  }

  function buildDock() {
    var html = dockApps().map(function (app, index) {
      var key = index < 9 ? String(index + 1) : '';
      return (
        '<button class="dock-app" type="button" draggable="true" data-app="' +
        esc(app.id) +
        '" title="' +
        esc(app.name) +
        (key ? '　Ctrl+' + key : '') +
        '">' +
        '<span class="glyph' + appIconClass(app) + '">' +
        appIconHTML(app) +
        '</span>' +
        (key ? '<span class="shortcut">' + key + '</span>' : '') +
        '</button>'
      );
    }).join('');
    html +=
      '<span class="dock-sep"></span>' +
      '<button class="dock-app utility" type="button" data-act="launcher" title="所有应用　Ctrl+0">' +
      '<span class="glyph"><svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="3" y="3" width="7" height="7" fill="#e3a400" stroke="#26231f"/>' +
      '<rect x="14" y="3" width="7" height="7" fill="#5b7692" stroke="#26231f"/>' +
      '<rect x="3" y="14" width="7" height="7" fill="#7c7f42" stroke="#26231f"/>' +
      '<rect x="14" y="14" width="7" height="7" fill="#b56545" stroke="#26231f"/>' +
      '</svg></span></button>';
    els.dock.innerHTML = html;
  }

  function renderDock() {
    if (!els.dock) return;
    var activeApp = paneApp(state.focused);
    Array.prototype.forEach.call(els.dock.querySelectorAll('.dock-app[data-app]'), function (el) {
      var appId = el.dataset.app;
      el.classList.toggle('running', state.open.indexOf(appId) >= 0);
      el.classList.toggle('active', activeApp === appId);
      el.classList.toggle('has-share', !!shareBadges[appId]);
    });
  }

  function updateToolState() {
    if (!els.topbar) return;
    var dockBtn = els.topbar.querySelector('[data-act="dock"]');
    var focusBtn = els.topbar.querySelector('[data-act="focus"]');
    if (dockBtn) dockBtn.classList.toggle('active', state.dock);
    if (focusBtn) focusBtn.classList.toggle('active', !!state.maximized);
    if (!els.layoutMenu.hidden) renderLayoutMenu();
  }

  function renderLayoutMenu() {
    var items = els.layoutMenu.querySelectorAll('[data-preset]');
    Array.prototype.forEach.call(items, function (el) {
      var check = el.querySelector('.check');
      var on =
        (el.dataset.preset === 'focus' && state.maximized) ||
        (el.dataset.preset === 'single' && !state.maximized && leafIds(state.tree).length === 1);
      if (check) check.textContent = on ? '✓' : '';
    });
    renderWorkspaceList();
  }

  function initWorkspaceMenu() {
    if (!els.layoutMenu || document.getElementById('ws-list')) return;
    els.layoutMenu.insertAdjacentHTML(
      'beforeend',
      '<div class="menu-sep"></div>' +
      '<div class="ws-head">工作区</div>' +
      '<div id="ws-list"></div>' +
      '<button class="menu-item" type="button" data-ws="save"><span class="check"></span>保存当前布局…</button>' +
      '<div class="ws-save" id="ws-save" hidden>' +
      '<input id="ws-name" maxlength="20" placeholder="工作区名称" autocomplete="off" />' +
      '<button type="button" data-ws="commit">保存</button>' +
      '<button type="button" data-ws="cancel">×</button></div>'
    );
    renderWorkspaceList();
  }

  function renderWorkspaceList() {
    var list = document.getElementById('ws-list');
    if (!list) return;
    if (!workspaces.length) {
      list.innerHTML = '<div class="ws-head" style="text-transform:none;letter-spacing:0">还没有保存的工作区</div>';
      return;
    }
    list.innerHTML = workspaces.map(function (item) {
      return (
        '<div class="ws-row">' +
        '<button class="menu-item" type="button" data-ws-apply="' + esc(item.id) + '">' +
        '<span class="check">' + (item.id === activeWorkspaceId ? '✓' : '') + '</span>' +
        esc(item.name) +
        '</button>' +
        '<button class="ws-del" type="button" data-ws-del="' + esc(item.id) + '" title="删除工作区">×</button>' +
        '</div>'
      );
    }).join('');
  }

  function saveCurrentWorkspace(name) {
    var text = String(name || '').trim().slice(0, 20);
    if (!text) return false;
    var snapshot = {
      open: state.open.slice(),
      tree: JSON.parse(JSON.stringify(state.tree)),
      panes: Object.assign({}, state.panes),
      focused: state.focused,
      maximized: state.maximized,
      dock: state.dock,
    };
    var existing = null;
    workspaces.forEach(function (item) {
      if (item.name === text) existing = item;
    });
    if (existing) {
      existing.state = snapshot;
      existing.at = Date.now();
      activeWorkspaceId = existing.id;
    } else {
      var item = {
        id: 'ws' + Date.now(),
        name: text,
        at: Date.now(),
        state: snapshot,
      };
      workspaces.unshift(item);
      activeWorkspaceId = item.id;
    }
    workspaces = workspaces.slice(0, 8);
    saveWorkspaces();
    renderWorkspaceList();
    toast(existing ? '已更新工作区「' + text + '」' : '已保存工作区「' + text + '」');
    return true;
  }

  function applyWorkspace(workspaceId) {
    var workspace = null;
    workspaces.forEach(function (item) {
      if (item.id === workspaceId) workspace = item;
    });
    if (!workspace) return;
    var data = workspace.state || {};
    var open = (data.open || []).filter(function (id) { return APP_BY_ID[id]; });
    var tree = data.tree;
    if (!validTree(tree, {})) tree = { type: 'leaf', id: 'p1' };
    var ids = leafIds(tree);
    var panes = {};
    var seen = {};
    ids.forEach(function (paneId) {
      var app = data.panes ? data.panes[paneId] : null;
      if (!app || !APP_BY_ID[app] || seen[app]) app = null;
      panes[paneId] = app;
      if (app) seen[app] = true;
    });
    var oldOpen = state.open.slice();
    oldOpen.forEach(function (id) {
      if (open.indexOf(id) < 0) destroyFrame(id);
    });
    state.open = open;
    state.tree = tree;
    state.panes = panes;
    state.focused = ids.indexOf(data.focused) >= 0 ? data.focused : ids[0];
    state.maximized =
      data.maximized && ids.indexOf(data.maximized) >= 0 ? data.maximized : null;
    state.dock = data.dock !== false;
    activeWorkspaceId = workspace.id;
    ensureSplitKeys(state.tree);
    syncSplitSeq(state.tree);
    applyDockState();
    renderAll();
    mountVisible();
    save();
    toast('已切换到工作区「' + workspace.name + '」');
  }

  function deleteWorkspace(workspaceId) {
    workspaces = workspaces.filter(function (item) { return item.id !== workspaceId; });
    if (activeWorkspaceId === workspaceId) activeWorkspaceId = '';
    saveWorkspaces();
    renderWorkspaceList();
  }

  var APP_ALIASES = {
    annotate: 'biao zhu bz pdf jingdu pizhu',
    corpus: 'yu liao ku ylk yuliao yingyu chaxun',
    data: 'shu ju biao ge sj bg csv excel xlsx',
    english: 'ying yu ci hui yy chui ting li cet6 beikao',
    latex: 'tex lun wen lw bian yi by',
    mdforge: 'markdown md docx tex zhuan huan zh',
    message: 'xiao xi xx tong bu tb wen jian',
    planner: 'ri cheng rc dai ban db shi jian sj',
    redact: 'tuo min tm pdf office',
    visualization: 'tu biao tb ke shi hua ksh chart',
    writer: 'xie zuo xz chang wen bi ji bj',
  };

  function launcherMatches(app, query) {
    var text = [
      app.name,
      app.description || '',
      app.id,
      app.glyph || '',
      APP_ALIASES[app.id] || '',
    ].join(' ').toLowerCase();
    var compact = text.replace(/\s+/g, '');
    return query.toLowerCase().split(/\s+/).filter(Boolean).every(function (token) {
      var narrow = token.replace(/\s+/g, '');
      return text.indexOf(token) >= 0 || (narrow && compact.indexOf(narrow) >= 0);
    });
  }

  function rememberApp(appId) {
    if (!appId || !APP_BY_ID[appId]) return;
    launcherRecent = [appId]
      .concat(launcherRecent.filter(function (id) { return id !== appId; }))
      .slice(0, 6);
    saveLauncherPrefs();
  }

  function togglePin(appId) {
    var index = launcherPinned.indexOf(appId);
    if (index >= 0) launcherPinned.splice(index, 1);
    else launcherPinned.unshift(appId);
    launcherPinned = launcherPinned.slice(0, 8);
    saveLauncherPrefs();
    renderLauncher(true);
    toast(index >= 0 ? '已取消固定' : '已固定到应用面板');
  }

  function launcherChip(app) {
    return (
      '<button class="launcher-chip" type="button" data-app="' +
      esc(app.id) +
      '"><span class="glyph' +
      appIconClass(app) +
      '">' +
      appIconHTML(app) +
      '</span>' +
      esc(app.name) +
      '</button>'
    );
  }

  function launcherApp(app, index) {
    var open = state.open.indexOf(app.id) >= 0;
    var pinned = launcherPinned.indexOf(app.id) >= 0;
    var key = APP_LIST.indexOf(app) < 9 ? 'Ctrl+' + (APP_LIST.indexOf(app) + 1) : '';
    return (
      '<div class="launcher-app' +
      (pinned ? ' pinned' : '') +
      (index === launcherIndex ? ' active' : '') +
      '" role="button" tabindex="0" data-app="' +
      esc(app.id) +
      '" data-launcher-idx="' +
      index +
      '">' +
      '<span class="glyph' +
      appIconClass(app) +
      '">' +
      appIconHTML(app) +
      '</span>' +
      '<span class="meta"><span class="name">' +
      esc(app.name) +
      (open ? ' ·' : '') +
      '</span><span class="desc">' +
      esc(app.description || '') +
      '</span></span>' +
      (key ? '<span class="key">' + key + '</span>' : '') +
      '<button class="launcher-pin' +
      (pinned ? ' on' : '') +
      '" type="button" data-pin="' +
      esc(app.id) +
      '" title="' +
      (pinned ? '取消固定' : '固定') +
      '">★</button></div>'
    );
  }

  function renderLauncher(focusInput) {
    if (!els.launcher) return;
    var query = launcherQuery.trim();
    var filtered = query
      ? APP_LIST.filter(function (app) { return launcherMatches(app, query); })
      : APP_LIST;
    if (launcherIndex >= filtered.length) launcherIndex = Math.max(0, filtered.length - 1);
    if (launcherIndex < 0) launcherIndex = 0;

    var html =
      '<div class="launcher-head"><span class="launcher-title">' +
      (query ? '搜索结果' : '所有应用') +
      '</span><span class="launcher-sub">Ctrl+K 搜索全部 · ↑↓ 选择</span></div>' +
      '<input class="launcher-search" id="launcher-search" type="search" ' +
      'placeholder="搜索应用：名称、描述、拼音首字母…" autocomplete="off" value="' +
      esc(launcherQuery) +
      '" />';

    if (query) {
      html += filtered.length
        ? '<div class="launcher-grid">' + filtered.map(function (app, index) {
            return launcherApp(app, index);
          }).join('') + '</div>'
        : '<div class="launcher-empty">没有匹配「' + esc(query) + '」的应用。<br>试试名称、描述或拼音首字母。</div>';
    } else {
      var pinned = launcherPinned.map(appOf).filter(Boolean);
      var recent = launcherRecent.map(appOf).filter(function (app) {
        return app && launcherPinned.indexOf(app.id) < 0;
      });
      if (pinned.length) {
        html += '<div class="launcher-section"><span>已固定</span></div><div class="launcher-recent">' +
          pinned.map(launcherChip).join('') + '</div>';
      }
      if (recent.length) {
        html += '<div class="launcher-section"><span>最近使用</span><span>点击直接恢复</span></div><div class="launcher-recent">' +
          recent.map(launcherChip).join('') + '</div>';
      }
      html += '<div class="launcher-section"><span>所有应用</span><span>Ctrl+1…9</span></div>' +
        '<div class="launcher-grid">' + filtered.map(function (app, index) {
          return launcherApp(app, index);
        }).join('') + '</div>';
    }

    html +=
      '<div class="launcher-foot"><span>Ctrl+0 打开此面板</span><span>拖动标签到窗格边缘可分屏</span>' +
      '<span>Ctrl+K 命令面板</span></div>';
    els.launcher.innerHTML = html;

    if (focusInput) {
      var input = document.getElementById('launcher-search');
      if (input) {
        input.focus();
        try {
          input.setSelectionRange(input.value.length, input.value.length);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  function moveLauncher(delta) {
    var items = els.launcher.querySelectorAll('.launcher-app[data-app]');
    if (!items.length) return;
    launcherIndex = (launcherIndex + delta + items.length) % items.length;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', i === launcherIndex);
    }
    var active = items[launcherIndex];
    if (active) {
      try {
        active.scrollIntoView({ block: 'nearest' });
      } catch (e) {
        /* ignore */
      }
    }
  }

  function applyDockState() {
    els.app.classList.toggle('dock-hidden', !state.dock);
    updateToolState();
    scheduleLayout();
  }

  /* ------------------------------------------------------------ plugin panel */

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function loadHubAppearance() {
    try {
      var raw = localStorage.getItem(APPEARANCE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      hubAppearance.radius = [0, 4, 8, 12, 16].indexOf(Number(data.radius)) >= 0
        ? Number(data.radius)
        : 0;
      hubAppearance.accentHex = normalizeHex(data.accentHex) || '';
      hubAppearance.accent = (data.accent === 'custom' || ACCENTS.some(function (tone) { return tone.id === data.accent; }))
        ? data.accent
        : 'amber';
      hubAppearance.motion = data.motion !== false;
      hubAppearance.topbar = data.topbar !== false;
      hubAppearance.restore = data.restore !== false;
      hubAppearance.sleep = [0, 5, 15, 30].indexOf(Number(data.sleep)) >= 0
        ? Number(data.sleep)
        : 15;
      hubAppearance.theme = ['light', 'dark', 'system'].indexOf(data.theme) >= 0
        ? data.theme
        : 'light';
      hubAppearance.snap = [0, 5, 10, 30].indexOf(Number(data.snap)) >= 0
        ? Number(data.snap)
        : 0;
      hubAppearance.dockSort = data.dockSort === 'usage' ? 'usage' : 'fixed';
    } catch (e) {
      /* ignore */
    }
  }

  function loadLauncherPrefs() {
    try {
      var pins = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
      launcherPinned = Array.isArray(pins) ? pins.filter(function (id) {
        return typeof id === 'string';
      }).slice(0, 8) : [];
    } catch (e) {
      launcherPinned = [];
    }
    try {
      var recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      launcherRecent = Array.isArray(recent) ? recent.filter(function (id) {
        return typeof id === 'string';
      }).slice(0, 8) : [];
    } catch (e) {
      launcherRecent = [];
    }
  }

  function saveLauncherPrefs() {
    try {
      localStorage.setItem(PIN_KEY, JSON.stringify(launcherPinned.slice(0, 8)));
      localStorage.setItem(RECENT_KEY, JSON.stringify(launcherRecent.slice(0, 8)));
    } catch (e) {
      /* ignore */
    }
  }

  function loadUsage() {
    try {
      var raw = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
      usageStats = raw && typeof raw === 'object' ? raw : {};
    } catch (e) {
      usageStats = {};
    }
  }

  function saveUsage() {
    try {
      localStorage.setItem(USAGE_KEY, JSON.stringify(usageStats));
    } catch (e) {
      /* ignore */
    }
  }

  function usageEntry(appId) {
    if (!usageStats[appId]) usageStats[appId] = { opens: 0, seconds: 0 };
    return usageStats[appId];
  }

  function usageScore(appId) {
    var entry = usageStats[appId];
    if (!entry) return -1;
    return (entry.opens || 0) * 2 + Math.round((entry.seconds || 0) / 60);
  }

  function loadWorkspaces() {
    try {
      var raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || '[]');
      workspaces = Array.isArray(raw) ? raw.filter(function (item) {
        return item && typeof item.id === 'string' && typeof item.name === 'string' && item.state;
      }).slice(0, 8) : [];
    } catch (e) {
      workspaces = [];
    }
    return workspaces;
  }

  function saveWorkspaces() {
    try {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspaces.slice(0, 8)));
    } catch (e) {
      /* ignore */
    }
  }

  function saveHubAppearance() {
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(hubAppearance));
    } catch (e) {
      /* ignore */
    }
    // Mirror the corner radius (and theme) into shared.json so native
    // surfaces — the update banner, tray menus, dialogs — follow the same
    // appearance settings.  Silently ignored in plain-browser mode.
    try {
      fetch('/__omm/fs/appearance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          radius: hubAppearance.radius,
          theme: hubAppearance.theme,
          accent: hubAppearance.accent,
          accentHex: hubAppearance.accentHex || '',
        }),
      }).catch(function () {});
    } catch (e) {
      /* ignore */
    }
  }

  var darkMedia = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function effectiveTheme() {
    if (hubAppearance.theme === 'system') {
      return darkMedia && darkMedia.matches ? 'dark' : 'light';
    }
    return hubAppearance.theme === 'dark' ? 'dark' : 'light';
  }

  function broadcastTheme(theme) {
    var payload = Object.assign({ type: 'omm:theme' }, accentBroadcastPayload(theme));
    frames.forEach(function (frame) {
      try {
        frame.contentWindow.postMessage(payload, '*');
      } catch (e) {
        /* frame not ready yet */
      }
    });
  }

  function applyTheme() {
    var theme = effectiveTheme();
    document.documentElement.dataset.theme = theme;
    applyAccentPalette();
    broadcastTheme(theme);
  }

  if (darkMedia && darkMedia.addEventListener) {
    darkMedia.addEventListener('change', function () {
      if (hubAppearance.theme === 'system') applyTheme();
    });
  }

  function applyHubAppearance() {
    if (!document.documentElement) return;
    document.documentElement.style.setProperty('--radius', hubAppearance.radius + 'px');
    document.documentElement.dataset.accent = hubAppearance.accent;
    document.documentElement.dataset.theme = effectiveTheme();
    applyAccentPalette();
    var tone = accentById(hubAppearance.accent);
    var accentName = document.getElementById('hub-accent-name');
    if (accentName) {
      accentName.textContent = hubAppearance.accent === 'custom'
        ? '· 自定义 ' + tone.light
        : '· ' + tone.name;
    }
    syncAccentHexControls();
    var themeSelect = document.getElementById('hub-theme');
    if (themeSelect) themeSelect.value = hubAppearance.theme;
    var snapSelect = document.getElementById('hub-snap');
    if (snapSelect) snapSelect.value = String(hubAppearance.snap);
    document.body.classList.toggle('no-motion', !hubAppearance.motion);
    els.app.classList.toggle('topbar-hidden', !hubAppearance.topbar);
    var restore = document.getElementById('hub-restore');
    if (restore) restore.setAttribute('aria-checked', String(hubAppearance.restore));
    var sleep = document.getElementById('hub-sleep');
    if (sleep) sleep.value = String(hubAppearance.sleep);
    Array.prototype.forEach.call(document.querySelectorAll('[data-hub-radius]'), function (btn) {
      btn.classList.toggle('active', Number(btn.dataset.hubRadius) === hubAppearance.radius);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-hub-accent]'), function (btn) {
      btn.classList.toggle('active', btn.dataset.hubAccent === hubAppearance.accent);
      var swatch = accentById(btn.dataset.hubAccent);
      btn.style.setProperty('--swatch', effectiveTheme() === 'dark' ? swatch.dark : swatch.light);
    });
    var motion = document.getElementById('hub-motion');
    if (motion) motion.setAttribute('aria-checked', String(hubAppearance.motion));
    var topbar = document.getElementById('hub-topbar');
    if (topbar) topbar.setAttribute('aria-checked', String(hubAppearance.topbar));
    broadcastTheme(effectiveTheme());
  }

  function openHubSettings() {
    closePopovers();
    closePluginPanel();
    closeCommandPalette();
    els.hubSettings.hidden = false;
    applyHubAppearance();
    loadStorage(false);
    renderUsage();
  }

  function closeHubSettings() {
    els.hubSettings.hidden = true;
  }

  /* Custom hex accent: OMM-ZEN styled, no native colour picker popup. */
  function bindAccentCustom() {
    var input = document.getElementById('hub-accent-hex');
    var applyBtn = document.getElementById('hub-accent-apply');
    var clearBtn = document.getElementById('hub-accent-clear');
    var preview = document.getElementById('hub-accent-hex-preview');
    var hint = document.getElementById('hub-accent-hex-hint');
    if (!input || !applyBtn || !hint) return;

    function setHint(text, isError) {
      hint.textContent = text;
      hint.classList.toggle('error', !!isError);
    }
    function currentHex() {
      return normalizeHex(input.value) || normalizeHex(hubAppearance.accentHex) || DEFAULT_CUSTOM_HEX;
    }
    function useHex(hex, message) {
      hubAppearance.accent = 'custom';
      hubAppearance.accentHex = hex;
      input.value = hex.slice(1);
      saveHubAppearance();
      applyHubAppearance();
      setHint('已应用 ' + hex + '；深色主题自动提亮为 ' + accentForDark(hex) + '。', false);
      if (message) toast(message);
      /* A finished choice must not leave the control focused. */
      if (input.blur) input.blur();
      if (applyBtn.blur) applyBtn.blur();
      if (preview && preview.blur) preview.blur();
    }
    function applyCustom() {
      var hex = normalizeHex(input.value);
      if (!hex) {
        setHint('请输入 3 位或 6 位十六进制色值，例如 #FF8FC8。', true);
        if (input.focus) input.focus();
        return;
      }
      useHex(hex, '主题色已设为 ' + hex);
    }

    applyBtn.addEventListener('click', applyCustom);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyCustom();
      }
    });
    input.addEventListener('input', function () {
      var hex = normalizeHex(input.value);
      if (hex && preview) preview.style.setProperty('--swatch', hex);
      if (hint.classList.contains('error')) setHint(ACCENT_HEX_HINT, false);
    });
    if (preview) {
      preview.addEventListener('click', function () {
        var hex = currentHex();
        useHex(hex, '主题色已设为 ' + hex);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        hubAppearance.accent = 'amber';
        hubAppearance.accentHex = '';
        input.value = '';
        saveHubAppearance();
        applyHubAppearance();
        setHint(ACCENT_HEX_HINT, false);
        toast('已清除自定义颜色');
        if (clearBtn.blur) clearBtn.blur();
      });
    }
  }

  function bindHubSettings() {
    if (!els.hubSettings) return;
    /* Build the palette and replace every native select before binding, so the
       click handlers below see the real controls. */
    buildAccentSwatches();
    if (window.OMMUI && window.OMMUI.enhanceSelect) window.OMMUI.enhanceSelect(document);
    applyHubAppearance();
    bindAccentCustom();
    document.getElementById('hub-settings-close').addEventListener('click', closeHubSettings);
    document.getElementById('hub-settings-done').addEventListener('click', closeHubSettings);
    els.hubSettings.addEventListener('click', function (event) {
      if (event.target === els.hubSettings) closeHubSettings();
    });
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-hub-radius]'),
      function (btn) {
        btn.addEventListener('click', function () {
          hubAppearance.radius = Number(btn.dataset.hubRadius);
          saveHubAppearance();
          applyHubAppearance();
        });
      }
    );
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-hub-accent]'),
      function (btn) {
        btn.addEventListener('click', function () {
          hubAppearance.accent = btn.dataset.hubAccent;
          if (hubAppearance.accent === 'custom' && !normalizeHex(hubAppearance.accentHex)) {
            hubAppearance.accentHex = DEFAULT_CUSTOM_HEX;
          }
          var hint = document.getElementById('hub-accent-hex-hint');
          if (hint) {
            hint.textContent = ACCENT_HEX_HINT;
            hint.classList.remove('error');
          }
          saveHubAppearance();
          applyHubAppearance();
        });
      }
    );
    var motion = document.getElementById('hub-motion');
    if (motion) {
      motion.addEventListener('click', function () {
        hubAppearance.motion = !hubAppearance.motion;
        saveHubAppearance();
        applyHubAppearance();
      });
    }
    var topbar = document.getElementById('hub-topbar');
    if (topbar) {
      topbar.addEventListener('click', function () {
        hubAppearance.topbar = !hubAppearance.topbar;
        saveHubAppearance();
        applyHubAppearance();
        scheduleLayout();
      });
    }
    var reveal = document.getElementById('topbar-reveal');
    if (reveal) {
      reveal.addEventListener('click', function () {
        hubAppearance.topbar = true;
        saveHubAppearance();
        applyHubAppearance();
        scheduleLayout();
      });
    }
    var restoreSession = document.getElementById('hub-restore');
    if (restoreSession) {
      restoreSession.addEventListener('click', function () {
        hubAppearance.restore = !hubAppearance.restore;
        saveHubAppearance();
        applyHubAppearance();
        toast(hubAppearance.restore ? '下次启动会恢复本次会话' : '下次启动将打开空白工作台');
      });
    }
    var sleepSelect = document.getElementById('hub-sleep');
    if (sleepSelect) {
      sleepSelect.addEventListener('change', function () {
        hubAppearance.sleep = Number(sleepSelect.value) || 0;
        saveHubAppearance();
        applyHubAppearance();
        toast(hubAppearance.sleep ? '隐藏标签 ' + hubAppearance.sleep + ' 分钟后自动休眠' : '已关闭自动休眠');
      });
    }
    var themeSelect = document.getElementById('hub-theme');
    if (themeSelect) {
      themeSelect.addEventListener('change', function () {
        hubAppearance.theme = themeSelect.value;
        saveHubAppearance();
        applyTheme();
        applyHubAppearance();
        toast(
          hubAppearance.theme === 'system'
            ? '将跟随系统的深浅色设置'
            : hubAppearance.theme === 'dark'
              ? '已切换到深色主题'
              : '已切换到浅色主题'
        );
      });
    }
    var snapSelect = document.getElementById('hub-snap');
    if (snapSelect) {
      snapSelect.addEventListener('change', function () {
        hubAppearance.snap = Number(snapSelect.value) || 0;
        lastAutoSnapAt = Date.now();
        saveHubAppearance();
        applyHubAppearance();
        toast(hubAppearance.snap ? '每 ' + hubAppearance.snap + ' 分钟为当前产品自动快照' : '已关闭定时快照');
      });
    }
    var resetLayoutBtn = document.getElementById('hub-reset-layout');
    if (resetLayoutBtn) resetLayoutBtn.addEventListener('click', function () { resetLayout(true); });
    var closeAllBtn = document.getElementById('hub-close-all');
    if (closeAllBtn) closeAllBtn.addEventListener('click', function () { closeAllTabs(true); });
    var refreshStorage = document.getElementById('hub-refresh-storage');
    if (refreshStorage) refreshStorage.addEventListener('click', function () { loadStorage(true); });
    var openSave = document.getElementById('hub-open-save');
    if (openSave) openSave.addEventListener('click', function () { openStoragePath('save'); });
    var openShared = document.getElementById('hub-open-shared');
    if (openShared) openShared.addEventListener('click', function () { openStoragePath('share'); });
    var backup = document.getElementById('hub-backup');
    if (backup) backup.addEventListener('click', downloadBackup);
    var restorePick = document.getElementById('hub-restore-pick');
    var restoreFile = document.getElementById('hub-restore-file');
    if (restorePick && restoreFile) {
      restorePick.addEventListener('click', function () { restoreFile.click(); });
      restoreFile.addEventListener('change', function () {
        var file = restoreFile.files && restoreFile.files[0];
        restoreFile.value = '';
        if (file) restoreBackup(file);
      });
    }
    var dockUsage = document.getElementById('hub-dock-usage');
    if (dockUsage) {
      dockUsage.addEventListener('click', function () {
        hubAppearance.dockSort = 'usage';
        saveHubAppearance();
        buildDock();
        renderDock();
        renderUsage();
        toast('Dock 已按使用频率排序');
      });
    }
    var dockFixed = document.getElementById('hub-dock-fixed');
    if (dockFixed) {
      dockFixed.addEventListener('click', function () {
        hubAppearance.dockSort = 'fixed';
        saveHubAppearance();
        buildDock();
        renderDock();
        renderUsage();
        toast('Dock 已恢复默认排序');
      });
    }
    var checkUpdate = document.getElementById('hub-check-update');
    if (checkUpdate) {
      checkUpdate.addEventListener('click', function () {
        closeHubSettings();
        openPluginPanel('update');
      });
    }
    document.getElementById('hub-settings-reset').addEventListener('click', function () {
      hubAppearance = {
        radius: 0,
        accent: 'amber',
        accentHex: '',
        theme: 'light',
        motion: true,
        topbar: true,
        restore: true,
        sleep: 15,
        snap: 0,
        dockSort: 'fixed',
      };
      saveHubAppearance();
      applyHubAppearance();
      var accentHint = document.getElementById('hub-accent-hex-hint');
      if (accentHint) {
        accentHint.textContent = ACCENT_HEX_HINT;
        accentHint.classList.remove('error');
      }
      scheduleLayout();
      toast('外观与偏好已恢复默认');
    });
  }

  function usageRows() {
    return APP_LIST
      .map(function (app) {
        var entry = usageStats[app.id] || { opens: 0, seconds: 0 };
        return { app: app, opens: entry.opens || 0, seconds: entry.seconds || 0 };
      })
      .filter(function (row) { return row.opens > 0 || row.seconds > 0; })
      .sort(function (a, b) { return b.opens * 2 + b.seconds / 60 - (a.opens * 2 + a.seconds / 60); });
  }

  function renderUsage() {
    var box = document.getElementById('hub-usage');
    if (!box) return;
    var rows = usageRows();
    if (!rows.length) {
      box.innerHTML = '<span class="storage-dim">暂无记录，使用产品后会显示打开次数与时长。</span>';
      return;
    }
    box.innerHTML = rows
      .slice(0, 6)
      .map(function (row) {
        var minutes = Math.round(row.seconds / 60);
        var time = minutes >= 60
          ? Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分'
          : minutes + ' 分钟';
        return (
          '<span>' + esc(row.app.name) + '</span><b>' +
          row.opens + ' 次 · ' + time + '</b>'
        );
      })
      .join('');
  }

  function fmtBytes(bytes) {
    var size = Number(bytes) || 0;
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
    return (size / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function loadStorage(force) {
    var box = document.getElementById('hub-storage');
    if (!box) return;
    if (!force && box.dataset.loaded === '1') return;
    box.innerHTML = '<span class="storage-dim">正在统计…</span>';
    fetch('/api/storage', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || '统计失败');
        box.innerHTML = [
          ['保存文件', fmtBytes(data.save.bytes) + ' · ' + data.save.files + ' 个'],
          ['其中快照', fmtBytes(data.snapshots.bytes) + ' · ' + data.snapshots.files + ' 个'],
          ['共享空间', fmtBytes(data.share.bytes) + ' · ' + data.share.files + ' 个'],
          ['插件', fmtBytes(data.plugins.bytes) + ' · ' + data.plugins.files + ' 个'],
          ['合计', fmtBytes(data.total.bytes)],
        ].map(function (pair) {
          return '<span>' + pair[0] + '</span><b>' + pair[1] + '</b>';
        }).join('');
        box.dataset.loaded = '1';
        var version = document.getElementById('hub-version');
        if (version) version.textContent = data.version || '—';
      })
      .catch(function (error) {
        box.innerHTML = '<span class="storage-dim">统计失败：' + esc(error.message || error) + '</span>';
      });
  }

  function openStoragePath(kind) {
    fetch('/api/storage/open?kind=' + encodeURIComponent(kind), { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || '打开失败');
      })
      .catch(function (error) {
        toast('打开失败：' + (error && error.message ? error.message : error), 'error');
      });
  }

  function backupStamp() {
    var date = new Date();
    function pad(value) { return (value < 10 ? '0' : '') + value; }
    return (
      date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' +
      pad(date.getHours()) + pad(date.getMinutes())
    );
  }

  function downloadBackup() {
    fetch('/api/backup', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (server) {
        if (!server || !server.ok) throw new Error((server && server.error) || '备份失败');
        var payload = Object.assign({}, server, {
          appearance: hubAppearance,
          workspaces: workspaces,
          launcher: { pinned: launcherPinned, recent: launcherRecent },
        });
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'omm-zen-backup-' + backupStamp() + '.json';
        document.body.appendChild(anchor);
        anchor.click();
        setTimeout(function () {
          URL.revokeObjectURL(url);
          anchor.remove();
        }, 4000);
        toast('已生成备份：设置 + 共享规则 + 工作区');
      })
      .catch(function (error) {
        toast('备份失败：' + (error && error.message ? error.message : error), 'error');
      });
  }

  function normalizeAppearance(raw) {
    var data = raw && typeof raw === 'object' ? raw : {};
    return {
      radius: [0, 4, 8, 12, 16].indexOf(Number(data.radius)) >= 0 ? Number(data.radius) : 0,
      accentHex: normalizeHex(data.accentHex) || '',
      accent: (data.accent === 'custom' || ACCENTS.some(function (tone) { return tone.id === data.accent; }))
        ? data.accent
        : 'amber',
      theme: ['light', 'dark', 'system'].indexOf(data.theme) >= 0 ? data.theme : 'light',
      motion: data.motion !== false,
      topbar: data.topbar !== false,
      restore: data.restore !== false,
      sleep: [0, 5, 15, 30].indexOf(Number(data.sleep)) >= 0 ? Number(data.sleep) : 15,
      snap: [0, 5, 10, 30].indexOf(Number(data.snap)) >= 0 ? Number(data.snap) : 0,
      dockSort: data.dockSort === 'usage' ? 'usage' : 'fixed',
    };
  }

  function restoreBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data = null;
      try {
        data = JSON.parse(String(reader.result || ''));
      } catch (e) {
        toast('不是有效的 JSON 备份', 'error');
        return;
      }
      if (!data || typeof data !== 'object' || !data.shared) {
        toast('不是 OMM-ZEN 设置备份', 'error');
        return;
      }
      ommConfirm(
        '恢复会覆盖当前的保存路径、快照/共享设置与频道规则。\n' +
        '不会删除已有文件或插件，恢复前会自动备份当前配置。继续？',
        { title: '恢复备份', ok: '恢复', danger: true }
      ).then(function (ok) {
        if (!ok) return;
        fetch('/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shared: data.shared, policy: data.policy }),
        })
          .then(function (response) {
            return response.json().then(function (result) {
              if (!response.ok || !result.ok) throw new Error((result && result.error) || '恢复失败');
              return result;
            });
          })
          .then(function () {
            if (data.appearance) {
              hubAppearance = normalizeAppearance(data.appearance);
              saveHubAppearance();
            }
            if (Array.isArray(data.workspaces)) {
              workspaces = data.workspaces.filter(function (item) {
                return item && typeof item.id === 'string' && typeof item.name === 'string' && item.state;
              }).slice(0, 8);
              saveWorkspaces();
            }
            if (data.launcher && typeof data.launcher === 'object') {
              if (Array.isArray(data.launcher.pinned)) launcherPinned = data.launcher.pinned.slice(0, 8);
              if (Array.isArray(data.launcher.recent)) launcherRecent = data.launcher.recent.slice(0, 8);
              saveLauncherPrefs();
            }
            toast('设置已恢复，正在重新加载…');
            setTimeout(function () { location.reload(); }, 900);
          })
          .catch(function (error) {
            toast('恢复失败：' + (error && error.message ? error.message : error), 'error');
          });
      });
    };
    reader.onerror = function () { toast('读取备份失败', 'error'); };
    reader.readAsText(file);
  }

  function resetLayout(askConfirm) {
    function commit() {
      closeMany(state.open.slice(), { remember: false });
      state.tree = { type: 'leaf', id: 'p1' };
      state.panes = { p1: null };
      state.focused = 'p1';
      state.maximized = null;
      activeWorkspaceId = '';
      renderAll();
      save();
      toast('布局已重置');
    }
    if (askConfirm) {
      ommConfirm('关闭所有标签并恢复为单个空窗格？工作区与设置不受影响。',
        { title: '重置布局', ok: '重置', danger: true }).then(function (ok) {
        if (ok) commit();
      });
      return;
    }
    commit();
  }

  function closeAllTabs(askConfirm) {
    if (askConfirm) {
      ommConfirm('关闭所有标签？未保存的应用状态请先在应用内保存。',
        { title: '关闭所有标签', ok: '全部关闭', danger: true }).then(function (ok) {
        if (ok) closeMany(state.open.slice());
      });
      return;
    }
    closeMany(state.open.slice());
  }

  function openPluginPanel(tab) {
    closeCommandPalette();
    closePopovers();
    if (els.hubSettings) els.hubSettings.hidden = true;
    if (tab) pluginPanelTab = tab;
    if (pluginPanelTab === 'update') {
      /* Always report fresh framework + plugin versions on entry. */
      updateInfo = null;
      catalogCache = null;
      catalogError = '';
      els.ppStatus.textContent = '框架与插件版本检查';
    } else {
      els.ppStatus.textContent = '按需安装产品，或导入自己的插件';
    }
    els.pluginPanel.hidden = false;
    renderPluginPanel();
  }

  function closePluginPanel() {
    els.pluginPanel.hidden = true;
    catalogCache = null;
    catalogError = '';
  }

  function setPluginTab(tab) {
    pluginPanelTab = tab;
    if (tab === 'update') catalogError = '';
    if (tab !== 'installed') pluginDirEditing = false;
    Array.prototype.forEach.call(
      els.pluginPanel.querySelectorAll('[data-pp-tab]'),
      function (el) {
        el.classList.toggle('active', el.dataset.ppTab === tab);
      }
    );
    renderPluginPanel();
  }

  function renderPluginPanel() {
    if (!els.ppBody || els.pluginPanel.hidden) return;
    if (pluginPanelTab === 'installed') renderInstalledPlugins();
    else if (pluginPanelTab === 'online') renderOnlinePlugins();
    else if (pluginPanelTab === 'import') renderImportPlugin();
    else if (pluginPanelTab === 'update') renderUpdatePanel();
    else renderPluginSpec();
  }

  function pluginRow(app, source, version) {
    var user = source === 'user';
    return (
      '<div class="pp-row">' +
      '<span class="pp-glyph' + appIconClass(app) + '">' +
      appIconHTML(app) +
      '</span>' +
      '<span class="pp-meta"><span class="pp-name">' +
      esc(app.name) +
      '<span class="pp-badge ' +
      (user ? 'user' : '') +
      '">' +
      (user ? '用户安装' : '内置') +
      '</span></span>' +
      '<span class="pp-desc">' +
      esc(app.description || '') +
      '</span></span>' +
      '<span class="pp-version">' +
      esc(version || app.version || '') +
      '</span>' +
      '<span class="pp-actions">' +
      '<button class="pp-btn" type="button" data-pp-action="open" data-id="' +
      esc(app.id) +
      '">打开</button>' +
      (user
        ? '<button class="pp-btn danger" type="button" data-pp-action="remove" data-id="' +
          esc(app.id) +
          '">卸载</button>'
        : '') +
      '</span></div>'
    );
  }

  function renderInstalledPlugins() {
    if (!APP_LIST.length) {
      els.ppBody.innerHTML =
        '<div class="pp-empty">还没有安装插件。<br>切换到「在线插件」选择产品，或「导入插件」安装自己的页面。</div>';
      return;
    }
    var rows = APP_LIST.map(function (app) {
      return pluginRow(app, app.source, app.version);
    }).join('');
    els.ppBody.innerHTML =
      '<p class="pp-note">插件按需安装，安装后立即出现在顶部标签、Dock 和应用面板中。内置插件可以保留，也可以被在线版本覆盖。</p>' +
      dirBarHtml() +
      '<div class="pp-list">' +
      rows +
      '</div>' +
      '<div class="pp-foot"><span>共 ' + APP_LIST.length + ' 个插件</span><span>内置 ' +
      APP_LIST.filter(function (a) { return a.source !== 'user'; }).length + ' · 用户安装 ' +
      APP_LIST.filter(function (a) { return a.source === 'user'; }).length +
      '</span></div>';
  }

  /* Plugin install directory: shown above the list, editable in place. */
  function dirBarHtml() {
    if (pluginDirEditing) {
      return (
        '<div class="pp-dir pp-dir-edit">' +
        '<input class="pp-input" id="pp-dir-input" spellcheck="false" autocomplete="off" ' +
        'value="' + esc(PLUGIN_DIR) + '" placeholder="D:\\OMM-ZEN\\plugins" />' +
        '<button class="pp-btn primary" type="button" data-pp-action="save-dir">迁移到此处</button>' +
        '<button class="pp-btn" type="button" data-pp-action="cancel-dir">取消</button>' +
        '</div>' +
        '<p class="pp-dir-hint">修改后会立即迁移；成功后旧目录（含空文件夹）会被删除。</p>'
      );
    }
    return (
      '<div class="pp-dir">' +
      '<span class="pp-dir-label">安装目录</span>' +
      '<code class="pp-dir-path" title="' + esc(PLUGIN_DIR) + '">' + esc(PLUGIN_DIR) + '</code>' +
      '<button class="pp-btn" type="button" data-pp-action="change-dir">修改</button>' +
      '</div>' +
      '<p class="pp-dir-hint">修改后会立即迁移；成功后旧目录（含空文件夹）会被删除。</p>'
    );
  }

  function applyPluginDir() {
    var input = document.getElementById('pp-dir-input');
    if (!input) return;
    var path = String(input.value || '').trim();
    if (!path) {
      toast('请填写目录');
      return;
    }
    var count = APP_LIST.filter(function (a) { return a.source === 'user'; }).length;
    var message =
      '把插件安装目录改为：\n' + path + '\n\n' +
      (count ? '已安装的 ' + count + ' 个用户插件会自动迁移过去。\n' : '') +
      '迁移成功后旧目录（含空文件夹）会被删除，已打开的产品会重新加载。继续？';
    function commit() {
      var button = document.querySelector('[data-pp-action="save-dir"]');
      if (button) {
        button.disabled = true;
        button.textContent = '迁移中…';
      }
      fetch('/api/settings/plugin-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path }),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok || !data.ok) {
              throw new Error((data && data.error) || '修改失败');
            }
            return data;
          });
        })
        .then(function (data) {
          pluginDirEditing = false;
          PLUGIN_DIR = data.plugin_dir || path;
          if (els.pluginPanel) els.pluginPanel.dataset.dir = PLUGIN_DIR;
          toast(
            data.unchanged
              ? '目录未变：' + PLUGIN_DIR
              : '已迁移 ' + (data.moved || 0) + ' 项到 ' + PLUGIN_DIR +
                (data.leftover ? '（旧目录仍有文件未能删除）' : '，旧目录已删除')
          );
          /* Plugin servers were restarted from the new location, so every open
             app has to be mounted again. */
          var open = state.open.slice();
          open.forEach(function (appId) {
            invalidateApp(appId);
          });
          return loadPlugins(false).then(function () {
            open.forEach(function (appId) {
              if (APP_BY_ID[appId]) reloadApp(appId);
            });
            renderPluginPanel();
          });
        })
        .catch(function (error) {
          toast((error && error.message) || '目录修改失败');
          pluginDirEditing = true;
          renderPluginPanel();
        });
    }

    ommConfirm(message, { title: '迁移插件目录', ok: '迁移', danger: true }).then(function (ok) {
      if (ok) commit();
    });
  }

  function versionKey(value) {
    var parts = String(value || '').match(/\d+/g) || [];
    return parts.slice(0, 4).map(function (part) {
      return parseInt(part, 10) || 0;
    });
  }

  function isNewerVersion(latest, current) {
    var a = versionKey(latest);
    var b = versionKey(current);
    if (!a.length) return false;
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] || 0;
      var y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  /* Framework update: the shell itself. */
  function frameworkUpdateHtml() {
    if (!updateInfo) return '<div class="pp-empty">正在检查框架更新…</div>';
    var info = updateInfo;
    if (info.error) {
      return '<div class="pp-empty">检查更新失败：' + esc(info.error) + '</div>';
    }
    var latest = info.latest || '';
    var current = info.current || '';
    if (!isNewerVersion(latest, current)) {
      return '<div class="pp-empty">工作台框架已是最新版本（' + esc(current || '未知') + '）。</div>';
    }
    return (
      '<div class="pp-list"><div class="pp-row">' +
      '<span class="pp-meta"><span class="pp-name">发现新版本 ' + esc(latest) +
      '<span class="pp-badge">可用</span></span>' +
      '<span class="pp-desc">当前 ' + esc(current) +
      (info.size ? ' · ' + (info.size / 1048576).toFixed(1) + ' MB' : '') +
      (info.url ? '' : ' · 仅支持下载后手动替换') +
      '</span></span><span class="pp-actions">' +
      (info.can_self_update
        ? '<button class="pp-btn primary" type="button" data-pp-action="apply-update">立即更新</button>'
        : '<button class="pp-btn primary" type="button" data-pp-action="download-update">下载</button>') +
      '</span></div></div>'
    );
  }

  /* Plugin update: report every plugin's local vs. catalog version. */
  function pluginUpdateHtml() {
    if (!catalogCache) {
      if (catalogError) {
        return (
          '<div class="pp-empty">插件版本目录读取失败：' + esc(catalogError) +
          '<br><br><button class="pp-btn" type="button" data-pp-action="reload-catalog">重试</button></div>'
        );
      }
      return '<div class="pp-empty">正在读取插件版本目录…</div>';
    }
    var items = catalogCache.plugins || [];
    if (!items.length) return '<div class="pp-empty">在线目录暂时没有插件版本信息。</div>';
    var installedCount = 0;
    var updatable = 0;
    var rows = items.map(function (item) {
      var local = APP_BY_ID[item.id];
      var installedVersion = item.installed_version || (local && local.version) || '';
      var latest = item.version || '';
      var installed = !!item.installed || !!local;
      if (installed) installedCount++;
      var canUpdate = installed && isNewerVersion(latest, installedVersion);
      if (canUpdate) updatable++;
      var localIsNewer = installed && installedVersion && latest && !canUpdate &&
        isNewerVersion(installedVersion, latest);
      var status = !installed
        ? '<span class="upd-status upd-none">未安装</span>'
        : canUpdate
          ? '<span class="upd-status upd-new">有更新</span>'
          : localIsNewer
            ? '<span class="upd-status upd-none">本地较新</span>'
            : '<span class="upd-status upd-ok">已是最新</span>';
      var busy = !!pluginBusy[item.id];
      var label = busy ? '处理中…' : canUpdate ? '更新' : installed ? '重装' : '安装';
      return (
        '<div class="pp-row">' +
        '<span class="pp-glyph' + appIconClass(item) + '">' + appIconHTML(item) + '</span>' +
        '<span class="pp-meta"><span class="pp-name">' + esc(item.name || item.id) + status + '</span>' +
        '<span class="pp-desc">' + esc(item.description || '') + '</span></span>' +
        '<span class="upd-version">' + esc(installedVersion || '—') + ' → ' + esc(latest || '—') + '</span>' +
        '<span class="pp-actions"><button class="pp-btn' + (canUpdate ? ' primary' : '') +
        '" type="button" data-pp-action="install" data-id="' + esc(item.id) + '"' +
        (busy ? ' disabled' : '') + '>' + esc(label) + '</button></span></div>'
      );
    }).join('');
    return (
      '<div class="upd-summary">共 ' + items.length + ' 个插件 · 已安装 ' + installedCount +
      ' 个 · <b>' + updatable + ' 个可更新</b> · 目录版本 ' + esc(catalogCache.version || '—') +
      '</div><div class="pp-list">' + rows + '</div>'
    );
  }

  function renderUpdatePanel() {
    if (!updateInfo && !updateChecking) checkHubUpdate();
    if (!catalogCache && !catalogLoading && !catalogError) loadCatalogForUpdate();
    var html =
      '<p class="pp-note">分别汇报工作台框架与每个插件的版本；有新版本时可直接替换当前程序或插件，重启后生效。</p>' +
      '<div class="upd-section"><div class="upd-head"><span>工作台框架</span>' +
      '<span class="upd-meta">' + esc((updateInfo && updateInfo.current) || '检测中…') + '</span></div>' +
      frameworkUpdateHtml() + '</div>' +
      '<div class="upd-section"><div class="upd-head"><span>插件版本</span>' +
      '<span class="upd-meta">在线目录 / 本地安装</span></div>' +
      pluginUpdateHtml() + '</div>' +
      '<div class="pp-foot"><span>框架 ' +
      esc((updateInfo && (updateInfo.latest || updateInfo.current)) || '—') +
      ' · 插件目录 ' + esc((catalogCache && catalogCache.version) || '—') +
      '</span><button class="pp-btn" type="button" data-pp-action="check-update">重新检查全部</button></div>';
    els.ppBody.innerHTML = html;
  }

  function loadCatalogForUpdate() {
    if (catalogLoading) return;
    catalogLoading = true;
    fetch('/api/catalog', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('在线目录加载失败（' + response.status + '）');
        return response.json();
      })
      .then(function (data) {
        catalogCache = data;
        catalogError = '';
        if (pluginPanelTab === 'update') renderUpdatePanel();
      })
      .catch(function (error) {
        catalogError = (error && error.message) || '网络不可用';
        if (pluginPanelTab === 'update') renderUpdatePanel();
      })
      .finally(function () { catalogLoading = false; });
  }

  function checkHubUpdate() {
    if (updateChecking) return;
    updateChecking = true;
    fetch('/__omm/update/check', { cache: 'no-store' })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        updateInfo = data || { error: '没有返回版本信息' };
        if (pluginPanelTab === 'update') renderUpdatePanel();
      })
      .catch(function (error) {
        updateInfo = { error: (error && error.message) || '检查更新失败' };
        if (pluginPanelTab === 'update') renderUpdatePanel();
      })
      .finally(function () { updateChecking = false; });
  }

  function applyHubUpdate() {
    if (!updateInfo || !updateInfo.available) {
      toast('没有可用的更新');
      return;
    }
    if (!updateInfo.can_self_update) {
      downloadHubUpdate();
      return;
    }
    toast('正在下载并校验更新…');
    fetch('/__omm/update/apply', { method: 'POST', cache: 'no-store' })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || '更新失败');
        toast('更新完成，工作台即将重启…');
      })
      .catch(function (error) {
        toast('更新失败：' + ((error && error.message) || error));
      });
  }

  function downloadHubUpdate() {
    if (!updateInfo || !updateInfo.url) {
      toast('没有可用的下载地址');
      return;
    }
    window.open(updateInfo.url, '_blank', 'noopener');
  }

  function renderOnlinePlugins() {
    if (!catalogCache) {
      els.ppBody.innerHTML = '<div class="pp-empty">正在获取在线插件目录…</div>';
      fetch('/api/catalog', { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('在线目录加载失败（' + response.status + '）');
          return response.json();
        })
        .then(function (data) {
          catalogCache = data;
          if (pluginPanelTab === 'online') renderOnlinePlugins();
        })
        .catch(function (error) {
          if (pluginPanelTab !== 'online') return;
          els.ppBody.innerHTML =
            '<div class="pp-empty">' +
            esc(error.message || '网络不可用') +
            '<br><br><button class="pp-btn" type="button" data-pp-action="reload-catalog">重试</button></div>';
        });
      return;
    }
    var items = catalogCache.plugins || [];
    if (!items.length) {
      els.ppBody.innerHTML = '<div class="pp-empty">在线目录暂时没有插件。</div>';
      return;
    }
    var cards = items
      .map(function (item) {
        var installed = item.installed;
        var busy = pluginBusy[item.id];
        var label = busy ? '处理中…' : installed ? (item.update_available ? '更新' : '重新安装') : '安装';
        return (
          '<div class="pp-card-item">' +
          '<div class="pp-card-top"><span class="pp-glyph' + appIconClass(item) + '">' +
          appIconHTML(item) +
          '</span><span class="pp-meta"><span class="pp-name">' +
          esc(item.name) +
          '<span class="pp-version">' +
          esc(item.version || '') +
          '</span></span><span class="pp-desc">' +
          esc(item.description || '') +
          '</span></span></div>' +
          '<div class="pp-actions"><span class="pp-version">' +
          formatBytes(item.size) +
          '</span><button class="pp-btn ' +
          (installed ? '' : 'primary') +
          '" type="button" data-pp-action="install" data-id="' +
          esc(item.id) +
          '"' +
          (busy ? ' disabled' : '') +
          '>' +
          esc(label) +
          '</button></div></div>'
        );
      })
      .join('');
    els.ppBody.innerHTML =
      '<p class="pp-note">在线插件来自 OMM-ZEN Release，下载后安装到本地，之后离线可用。</p>' +
      '<div class="pp-grid">' +
      cards +
      '</div>' +
      '<div class="pp-foot"><span>目录版本：' +
      esc(catalogCache.version || '') +
      '</span><button class="pp-btn" type="button" data-pp-action="reload-catalog">刷新目录</button></div>';
  }

  function renderImportPlugin() {
    els.ppBody.innerHTML =
      '<p class="pp-note">插件是一个 zip 包，根目录包含 <code>plugin.json</code> 和入口 HTML。导入的插件使用纯前端 <code>static</code> 运行时。</p>' +
      '<div class="pp-import" id="pp-drop">' +
      '<strong>拖入插件 zip，或选择文件</strong>' +
      '<span>最多 220 MB；入口页面和资源全部包含在包内</span>' +
      '<input type="file" id="pp-file" accept=".zip,application/zip">' +
      '<button class="pp-btn primary" type="button" data-pp-action="pick-file">选择插件包</button>' +
      '</div>' +
      '<div class="pp-foot"><span>安装位置：' +
      esc(PLUGIN_DIR) +
      '</span><button class="pp-btn" type="button" data-pp-action="show-spec">查看插件规范</button></div>';
    var drop = document.getElementById('pp-drop');
    var input = document.getElementById('pp-file');
    if (input) {
      input.addEventListener('change', function () {
        if (input.files && input.files[0]) importPluginFile(input.files[0]);
      });
    }
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (name) {
        drop.addEventListener(name, function (event) {
          event.preventDefault();
          drop.classList.add('drag');
        });
      });
      ['dragleave', 'drop'].forEach(function (name) {
        drop.addEventListener(name, function (event) {
          event.preventDefault();
          drop.classList.remove('drag');
        });
      });
      drop.addEventListener('drop', function (event) {
        var file = event.dataTransfer && event.dataTransfer.files[0];
        if (file) importPluginFile(file);
      });
    }
  }

  function renderPluginSpec() {
    els.ppBody.innerHTML = '<div class="pp-empty">正在载入插件规范…</div>';
    fetch('plugin-spec.md', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error();
        return response.text();
      })
      .then(function (text) {
        if (pluginPanelTab !== 'spec') return;
        els.ppBody.innerHTML =
          '<p class="pp-note">把页面打包成 zip，即可在「导入插件」中安装；完整字段说明如下。</p>' +
          '<pre class="pp-spec">' +
          esc(text) +
          '</pre>';
      })
      .catch(function () {
        els.ppBody.innerHTML =
          '<div class="pp-empty">无法读取 plugin-spec.md，请查看程序目录中的同名文件。</div>';
      });
  }

  var pluginBusy = {};

  function refreshPluginsAfterChange() {
    catalogCache = null;
    return loadPlugins(false).then(function () {
      if (!els.pluginPanel.hidden) renderPluginPanel();
    });
  }

  function installOnlinePlugin(pluginId) {
    if (pluginBusy[pluginId]) return;
    pluginBusy[pluginId] = true;
    /* Keep the current tab; the "update" tab must not jump to the online
       catalogue just because a plugin update was started there. */
    if (pluginPanelTab === 'online') renderOnlinePlugins();
    else renderPluginPanel();
    var wasOpen = !!findPaneByApp(pluginId);
    fetch('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pluginId }),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || data.ok === false) throw new Error(data.error || '安装失败');
          return data;
        });
      })
      .then(function (data) {
        var installedName = data && data.plugin ? data.plugin.name : pluginId;
        toast('插件已安装');
        pushNotify('插件已安装', installedName, { app: pluginId, kind: 'plugin' });
        return refreshPluginsAfterChange();
      })
      .then(function () {
        /* The plugin was replaced on disk: restart it right away so it can
           be used immediately instead of showing as unreachable. */
        if (wasOpen) reloadApp(pluginId);
        else invalidateApp(pluginId);
      })
      .catch(function (error) {
        toast(error.message || '安装失败');
        pushNotify('插件安装失败', (appOf(pluginId) ? appOf(pluginId).name : pluginId) + '：' + (error.message || ''), {
          app: pluginId,
          kind: 'error',
        });
      })
      .finally(function () {
        pluginBusy[pluginId] = false;
        if (pluginPanelTab === 'online' || pluginPanelTab === 'update') renderPluginPanel();
      });
  }

  function removePlugin(pluginId) {
    var app = appOf(pluginId);
    if (!app) return;
    function commit() {
      pluginBusy[pluginId] = true;
      closeTab(pluginId);
      fetch('/api/plugins/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pluginId }),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok || data.ok === false) throw new Error(data.error || '卸载失败');
            return data;
          });
        })
        .then(function (data) {
          toast(data.bundled_remains ? '已移除用户版本，内置版本仍可用' : '插件已卸载');
          pushNotify(
            data.bundled_remains ? '已移除用户版本' : '插件已卸载',
            app.name,
            { kind: 'plugin' }
          );
          return refreshPluginsAfterChange();
        })
        .catch(function (error) {
          toast(error.message || '卸载失败');
        })
        .finally(function () {
          pluginBusy[pluginId] = false;
          renderPluginPanel();
        });
    }
    ommConfirm('卸载「' + app.name + '」？本地数据会保留。',
      { title: '卸载插件', ok: '卸载', danger: true }).then(function (ok) {
      if (ok) commit();
    });
  }

  function importPluginFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name) && file.type !== 'application/zip') {
      toast('请选择 zip 插件包');
      return;
    }
    if (file.size > 220 * 1024 * 1024) {
      toast('插件包不能超过 220 MB');
      return;
    }
    els.ppStatus.textContent = '正在导入 ' + file.name + '…';
    file
      .arrayBuffer()
      .then(function (buffer) {
        return fetch('/api/plugins/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: buffer,
        });
      })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || data.ok === false) throw new Error(data.error || '导入失败');
          return data;
        });
      })
      .then(function (data) {
        var id = data.plugin && data.plugin.id;
        toast('已导入「' + (data.plugin ? data.plugin.name : file.name) + '」');
        els.ppStatus.textContent = '插件导入成功';
        return refreshPluginsAfterChange().then(function () {
          /* Restart the imported plugin so it is usable right away. */
          if (id) {
            if (findPaneByApp(id)) reloadApp(id);
            else invalidateApp(id);
          }
        });
      })
      .catch(function (error) {
        els.ppStatus.textContent = '导入失败';
        toast(error.message || '导入失败');
      });
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('on');
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(function () {
      els.toast.classList.remove('on');
    }, 1600);
  }

  function closePopovers() {
    launcherOpen = false;
    if (els.launcher) els.launcher.hidden = true;
    if (els.layoutMenu) els.layoutMenu.hidden = true;
    if (els.ctxMenu) els.ctxMenu.hidden = true;
    if (els.notifyPanel) els.notifyPanel.hidden = true;
    var tabsMore = document.getElementById('tabs-more');
    if (tabsMore) tabsMore.hidden = true;
    renderNotifyBadge();
  }

  /* The archive panel lives in the desktop bridge (omm-desktop.js), which the
     hub page loads as well.  Ask it to toggle. */
  function toggleArchive() {
    closePopovers();
    closePluginPanel();
    if (els.hubSettings) els.hubSettings.hidden = true;
    window.dispatchEvent(
      new CustomEvent('omm:archive', { detail: { action: 'toggle' } })
    );
  }

  /* A product asked the shell to bring another product to the front (share
     handoff, OMM Bridge delivery, a link to omm-*.html). */
  function openSharedApp(appId) {
    if (!appId) return;
    if (!APP_BY_ID[appId]) {
      toast('找不到应用：' + appId);
      return;
    }
    activateApp(appId);
    whenAppReady(appId, function (frame) {
      if (!frame) return;
      try {
        frame.contentWindow.postMessage({ type: 'omm:share-nudge' }, '*');
      } catch (e) {
        /* the product will pick its inbox up on boot instead */
      }
    });
  }

  window.addEventListener('omm:open-app', function (event) {
    var detail = event && event.detail ? event.detail : null;
    if (detail && detail.app) openSharedApp(detail.app);
  });

  /* A shared document was picked in the hub's archive: open the product that
     owns it and hand the file over once its frame exists. */
  window.addEventListener('omm:load-file', function (event) {
    var detail = event && event.detail ? event.detail : null;
    if (!detail || !detail.path) return;
    var appId = detail.app;
    if (!appId || !APP_BY_ID[appId]) {
      toast('找不到保存该文件的应用');
      return;
    }
    activateApp(appId);
    var tries = 0;
    var timer = window.setInterval(function () {
      tries += 1;
      var frame = frames.get(appId);
      if (frame && frame.contentWindow) {
        window.clearInterval(timer);
        try {
          frame.contentWindow.postMessage(
            {
              type: 'omm:load-file',
              path: detail.path,
              name: detail.name,
              mime: detail.mime,
            },
            '*'
          );
          toast('已交给「' + APP_BY_ID[appId].name + '」载入');
        } catch (e) {
          toast('载入失败');
        }
        return;
      }
      if (tries > 60) {
        window.clearInterval(timer);
        toast('应用启动超时');
      }
    }, 250);
  });

  function toggleLauncher(force) {
    var show = typeof force === 'boolean' ? force : !launcherOpen;
    closeCommandPalette();
    closePopovers();
    if (!show) {
      launcherOpen = false;
      launcherQuery = '';
      return;
    }
    launcherQuery = '';
    launcherIndex = 0;
    els.launcher.hidden = false;
    launcherOpen = true;
    renderLauncher(true);
  }

  function toggleLayoutMenu() {
    var show = els.layoutMenu.hidden;
    closePopovers();
    if (!show) return;
    renderLayoutMenu();
    els.layoutMenu.hidden = false;
  }

  /* ----------------------------------------------------------------- layout */

  function computeRects() {
    var panes = new Map();
    var splits = new Map();
    var width = els.workspace.clientWidth;
    var height = els.workspace.clientHeight;
    if (!width || !height) return { panes: panes, splits: splits };

    if (state.maximized && findLeafNode(state.maximized)) {
      panes.set(state.maximized, { x: 0, y: 0, w: width, h: height });
      return { panes: panes, splits: splits };
    }

    (function walk(node, x, y, w, h) {
      if (!node) return;
      if (node.type === 'leaf') {
        panes.set(node.id, { x: x, y: y, w: w, h: h });
        return;
      }
      ensureSplitKeys(node);
      var usableW = Math.max(0, w - SPLIT);
      var usableH = Math.max(0, h - SPLIT);
      if (node.dir === 'v') {
        var aw = usableW * node.ratio;
        walk(node.a, x, y, aw, h);
        splits.set(node.key, {
          node: node,
          x: x + aw,
          y: y,
          w: SPLIT,
          h: h,
          dir: 'v',
          region: { x: x, y: y, w: w, h: h },
        });
        walk(node.b, x + aw + SPLIT, y, w - aw - SPLIT, h);
      } else {
        var ah = usableH * node.ratio;
        walk(node.a, x, y, w, ah);
        splits.set(node.key, {
          node: node,
          x: x,
          y: y + ah,
          w: w,
          h: SPLIT,
          dir: 'h',
          region: { x: x, y: y, w: w, h: h },
        });
        walk(node.b, x, y + ah + SPLIT, w, h - ah - SPLIT);
      }
    })(state.tree, 0, 0, width, height);

    return { panes: panes, splits: splits };
  }

  function scheduleLayout() {
    if (layoutRaf) return;
    layoutRaf = window.requestAnimationFrame(function () {
      layoutRaf = 0;
      renderLayout();
    });
  }

  function renderLayout() {
    if (!els.workspace) return;
    var result = computeRects();
    layoutRects = result.panes;
    splitRegions = result.splits;
    updatePanes(result.panes);
    updateSplitters(result.splits);
    syncFrames(result.panes);
  }

  function createPaneElement(paneId) {
    var el = document.createElement('div');
    el.className = 'pane';
    el.dataset.pane = paneId;
    el.innerHTML =
      '<div class="pane-head">' +
      '<span class="pane-glyph"></span>' +
      '<span class="pane-name"></span>' +
      '<span class="pane-note"></span>' +
      '<span class="pane-spacer"></span>' +
      '<button class="pane-btn" type="button" data-act="pane-split-v" title="向右分屏">' +
      ICON_SPLIT_V +
      '</button>' +
      '<button class="pane-btn" type="button" data-act="pane-split-h" title="向下分屏">' +
      ICON_SPLIT_H +
      '</button>' +
      '<button class="pane-btn" type="button" data-act="pane-close" title="关闭窗格">×</button>' +
      '</div>' +
      '<div class="pane-body"><div class="pane-placeholder"></div></div>';
    els.paneLayer.appendChild(el);
    paneEls.set(paneId, el);
    return el;
  }

  function updatePanes(rects) {
    var alive = {};
    rects.forEach(function (rect, paneId) {
      alive[paneId] = true;
      var el = paneEls.get(paneId) || createPaneElement(paneId);
      el.style.left = rect.x + 'px';
      el.style.top = rect.y + 'px';
      el.style.width = Math.max(0, rect.w) + 'px';
      el.style.height = Math.max(0, rect.h) + 'px';
      el.classList.toggle('active', paneId === state.focused);
      updatePaneContent(el, paneId);
    });
    paneEls.forEach(function (el, paneId) {
      if (!alive[paneId]) {
        el.remove();
        paneEls.delete(paneId);
      }
    });
  }

  function placeholderHtml(app, paneId) {
    var status = app ? appStatus[app.id] || 'idle' : 'idle';
    if (!app) {
      if (!APP_LIST.length) {
        return (
          '<div class="empty-wrap"><div class="empty-title">还没有安装插件</div>' +
          '<div class="empty-sub">' +
          esc(pluginLoadError || '打开插件管理，选择要安装的产品，或导入自己的插件包。') +
          '</div>' +
          '<button class="retry-btn" type="button" data-act="open-plugins">打开插件管理</button>' +
          '</div>'
        );
      }
      var grid = APP_LIST.map(function (item) {
        return (
          '<button class="app-tile" type="button" data-app="' +
          esc(item.id) +
          '" title="' +
          esc(item.description || '') +
          '"><span class="glyph' + appIconClass(item) + '">' +
          appIconHTML(item) +
          '</span><span class="label">' +
          esc(item.name) +
          '</span></button>'
        );
      }).join('');
      var recent = '';
      if (recentFiles.length) {
        recent =
          '<div class="recent-files"><div class="recent-title">最近文件</div>' +
          recentFiles.slice(0, 4).map(function (file, index) {
            return (
              '<button class="recent-file" type="button" data-recent="' + index + '">' +
              '<b>' + esc(file.title || file.name || '未命名') + '</b>' +
              '<span>' + esc(file.app_name || file.app || '') + '</span></button>'
            );
          }).join('') + '</div>';
      }
      return (
        '<div class="empty-wrap"><div class="empty-title">选择一个应用</div>' +
        '<div class="empty-sub">点击打开，或把顶部标签拖到窗格边缘分屏</div>' +
        '<div class="app-grid">' + grid + '</div>' + recent + '</div>'
      );
    }
    if (status === 'loading' || status === 'idle') {
      return (
        '<div class="loading-box"><span class="spinner"></span><span>正在启动「' +
        esc(app.name) +
        '」…</span></div>'
      );
    }
    if (status === 'sleeping') {
      return (
        '<div class="loading-box"><span class="sleep-glyph">◌</span><span>「' +
        esc(app.name) +
        '」已休眠，内存已释放</span>' +
        '<button class="retry-btn" type="button" data-act="wake" data-app="' +
        esc(app.id) +
        '">唤醒</button></div>'
      );
    }
    if (status === 'error') {
      return (
        '<div class="error-box"><strong>无法启动「' +
        esc(app.name) +
        '」</strong><span>' +
        esc(appErrors[app.id] || '本地服务没有响应') +
        '</span>' +
        '<div class="error-actions">' +
        '<button class="retry-btn" type="button" data-act="retry" data-app="' + esc(app.id) + '">重试</button>' +
        '<button class="retry-btn" type="button" data-act="open-plugin" data-app="' + esc(app.id) + '">查看插件</button>' +
        '<button class="retry-btn" type="button" data-act="health">检查服务</button>' +
        '<button class="retry-btn" type="button" data-act="copy-error" data-app="' + esc(app.id) + '">复制错误</button>' +
        (lastSnapshotByApp[app.id]
          ? '<button class="retry-btn" type="button" data-act="restore-snap" data-app="' + esc(app.id) +
            '" title="恢复 ' + esc(lastSnapshotByApp[app.id].time || '') + ' 的快照后重新打开">恢复快照并重试</button>'
          : '') +
        '</div></div>'
      );
    }
    return '';
  }

  function updatePaneContent(el, paneId) {
    var app = appOf(paneApp(paneId));
    var status = app ? appStatus[app.id] || 'idle' : 'idle';
    el.querySelector('.pane-glyph').textContent = app ? app.glyph : '＋';
    el.querySelector('.pane-name').textContent = app ? app.name : '空窗格';
    var note = '';
    if (app) {
      if (status === 'loading' || status === 'idle') note = '正在启动…';
      else if (status === 'sleeping') note = '已休眠';
      else if (status === 'error') note = '启动失败';
      else if (findPaneByApp(app.id) !== paneId) note = '已打开';
    }
    el.querySelector('.pane-note').textContent = note;
    var closeBtn = el.querySelector('[data-act="pane-close"]');
    if (closeBtn) closeBtn.style.visibility = leafIds(state.tree).length > 1 ? 'visible' : 'hidden';

    var holder = el.querySelector('.pane-placeholder');
    var mode = app ? status : 'empty';
    if (holder.dataset.mode !== mode) {
      holder.dataset.mode = mode;
      holder.innerHTML = placeholderHtml(app, paneId);
    }
    holder.hidden = !!app && status === 'ready';
  }

  function updateSplitters(splits) {
    var alive = {};
    splits.forEach(function (info, key) {
      alive[key] = true;
      var el = splitterEls.get(key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'splitter';
        el.dataset.key = key;
        el.dataset.dir = info.dir;
        els.splitterLayer.appendChild(el);
        splitterEls.set(key, el);
      }
      el.dataset.dir = info.dir;
      el.style.left = info.x + 'px';
      el.style.top = info.y + 'px';
      el.style.width = info.w + 'px';
      el.style.height = info.h + 'px';
      el._region = info.region;
      el._node = info.node;
    });
    splitterEls.forEach(function (el, key) {
      if (!alive[key]) {
        el.remove();
        splitterEls.delete(key);
      }
    });
  }

  /* ----------------------------------------------------------------- frames */

  function createFrame(appId) {
    var frame = document.createElement('iframe');
    frame.className = 'app-frame';
    frame.dataset.app = appId;
    frame.setAttribute('title', appOf(appId) ? appOf(appId).name : appId);
    frame.setAttribute(
      'allow',
      'clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media'
    );
    frame.src = 'about:blank';
    frame.addEventListener('load', function () {
      if (!frame.dataset.url) return;
      appStatus[appId] = 'ready';
      try {
        frame.contentWindow.postMessage({ type: 'omm:theme', theme: effectiveTheme() }, '*');
      } catch (e) {
        /* ignore */
      }
      if (loadTimers[appId]) {
        window.clearTimeout(loadTimers[appId]);
        delete loadTimers[appId];
      }
      renderLayout();
    });
    els.iframeLayer.appendChild(frame);
    frames.set(appId, frame);
    return frame;
  }

  function destroyFrame(appId) {
    var frame = frames.get(appId);
    if (frame) {
      frame.remove();
      frames.delete(appId);
    }
    if (loadTimers[appId]) {
      window.clearTimeout(loadTimers[appId]);
      delete loadTimers[appId];
    }
    delete appStatus[appId];
    delete appErrors[appId];
  }

  function ensureApp(appId) {
    if (appUrls[appId]) return Promise.resolve(appUrls[appId]);
    if (ensurePromises[appId]) return ensurePromises[appId];
    var pending = fetch('/api/ensure?app=' + encodeURIComponent(appId), {
      cache: 'no-store',
    }).then(function (response) {
      if (!response.ok) throw new Error('本地服务启动失败（' + response.status + '）');
      return response.json();
    }).then(function (data) {
      if (!data || !data.url) throw new Error('本地服务没有返回地址');
      appUrls[appId] = data.url;
      return data.url;
    });
    ensurePromises[appId] = pending;
    pending.then(
      function () {
        delete ensurePromises[appId];
      },
      function () {
        delete ensurePromises[appId];
      }
    );
    return pending;
  }

  function mountApp(appId) {
    if (!appId) return;
    if (appStatus[appId] === 'ready' || appStatus[appId] === 'loading') return;
    appStatus[appId] = 'loading';
    appMountedAt[appId] = Date.now();
    appLastActive[appId] = Date.now();
    delete appErrors[appId];
    errorNotified[appId] = false;
    usageEntry(appId).opens += 1;
    saveUsage();
    refreshApp(appId);

    loadTimers[appId] = window.setTimeout(function () {
      if (appStatus[appId] !== 'loading') return;
      appStatus[appId] = 'error';
      appErrors[appId] = '页面加载超时';
      notifyAppError(appId);
      refreshApp(appId);
    }, 25000);

    ensureApp(appId).then(
      function (url) {
        if (appStatus[appId] === 'error') return;
        var frame = frames.get(appId) || createFrame(appId);
        var join = url.indexOf('?') >= 0 ? '&' : '?';
        frame.dataset.url = url;
        frame.src = url + join + 'omm_embed=1';
      },
      function (error) {
        if (loadTimers[appId]) {
          window.clearTimeout(loadTimers[appId]);
          delete loadTimers[appId];
        }
        appStatus[appId] = 'error';
        appErrors[appId] = error && error.message ? error.message : '本地服务没有响应';
        notifyAppError(appId);
        refreshApp(appId);
      }
    );
  }

  function refreshApp(appId) {
    var paneId = findPaneByApp(appId);
    if (paneId) {
      var el = paneEls.get(paneId);
      if (el) updatePaneContent(el, paneId);
    }
    renderDock();
  }

  function retryApp(appId) {
    destroyFrame(appId);
    delete appUrls[appId];
    delete appStatus[appId];
    mountApp(appId);
    renderLayout();
  }

  function syncFrames(rects) {
    var visible = {};
    rects.forEach(function (rect, paneId) {
      var appId = paneApp(paneId);
      if (!appId) return;
      var frame = frames.get(appId);
      if (!frame) return;
      if (appStatus[appId] !== 'ready') {
        frame.classList.remove('visible');
        return;
      }
      frame.style.left = rect.x + 1 + 'px';
      frame.style.top = rect.y + HEAD + 1 + 'px';
      frame.style.width = Math.max(0, rect.w - 2) + 'px';
      frame.style.height = Math.max(0, rect.h - HEAD - 2) + 'px';
      frame.classList.add('visible');
      visible[appId] = true;
    });
    frames.forEach(function (frame, appId) {
      if (!visible[appId]) frame.classList.remove('visible');
    });
  }

  /* ------------------------------------------------------------ pane actions */

  function syncFocusFromActive() {
    var active = document.activeElement;
    if (active && active.tagName === 'IFRAME' && active.dataset.app) {
      var pane = findPaneByApp(active.dataset.app);
      if (pane) setFocused(pane);
    }
  }

  function setFocused(paneId) {
    if (!paneId || !Object.prototype.hasOwnProperty.call(state.panes, paneId)) return;
    var appId = paneApp(paneId);
    if (appId) {
      appLastActive[appId] = Date.now();
      if (shareBadges[appId]) {
        delete shareBadges[appId];
        renderTabs();
      }
    }
    if (state.focused === paneId) return;
    state.focused = paneId;
    if (state.maximized) {
      state.maximized = paneId;
      renderLayout();
    }
    paneEls.forEach(function (el, id) {
      el.classList.toggle('active', id === paneId);
    });
    renderTabs();
    renderDock();
    updateToolState();
    save();
  }

  function activateApp(appId, paneId) {
    if (!APP_BY_ID[appId]) return;
    if (state.open.indexOf(appId) < 0) state.open.push(appId);
    rememberApp(appId);
    appLastActive[appId] = Date.now();
    var existing = findPaneByApp(appId);
    if (existing) {
      setFocused(existing);
      if (!frames.get(appId)) mountApp(appId);
      renderTabs();
      renderDock();
      return;
    }
    var target = paneId || state.focused || firstLeafId();
    if (!target || !Object.prototype.hasOwnProperty.call(state.panes, target)) {
      target = firstLeafId();
    }
    if (!target) return;
    assignApp(target, appId);
  }

  function assignApp(paneId, appId) {
    if (!APP_BY_ID[appId] || !Object.prototype.hasOwnProperty.call(state.panes, paneId)) {
      return;
    }
    var oldPane = findPaneByApp(appId);
    if (oldPane && oldPane !== paneId) state.panes[oldPane] = null;
    var replaced = state.panes[paneId];
    if (replaced && replaced !== appId) appLastActive[replaced] = Date.now();
    state.panes[paneId] = appId;
    if (state.open.indexOf(appId) < 0) state.open.push(appId);
    state.focused = paneId;
    if (state.maximized) state.maximized = paneId;
    rememberApp(appId);
    appLastActive[appId] = Date.now();
    if (shareBadges[appId]) delete shareBadges[appId];
    mountApp(appId);
    renderAll();
    save();
  }

  /* Close one or more tabs in one pass.  `closedStack` powers Ctrl+Shift+T. */
  function closeMany(ids, options) {
    var opts = options || {};
    var remove = {};
    ids.forEach(function (id) {
      if (state.open.indexOf(id) >= 0) remove[id] = true;
    });
    if (!Object.keys(remove).length) return;
    if (opts.remember !== false) {
      ids.forEach(function (id) {
        if (remove[id]) closedStack.push(id);
      });
      closedStack = closedStack.slice(-12);
    }
    state.open = state.open.filter(function (id) { return !remove[id]; });
    Object.keys(state.panes).forEach(function (paneId) {
      if (remove[state.panes[paneId]]) state.panes[paneId] = null;
    });
    ids.forEach(function (id) {
      if (!remove[id]) return;
      destroyFrame(id);
      delete appUrls[id];
      delete appLastActive[id];
      delete appMountedAt[id];
      delete shareBadges[id];
    });
    if (state.maximized && !paneApp(state.maximized)) state.maximized = null;
    renderAll();
    save();
  }

  function closeTab(appId) {
    closeMany([appId]);
  }

  function reopenLastClosed() {
    while (closedStack.length) {
      var appId = closedStack.pop();
      if (APP_BY_ID[appId]) {
        activateApp(appId);
        toast('已重新打开「' + APP_BY_ID[appId].name + '」');
        return;
      }
    }
    toast('没有可以重新打开的标签');
  }

  function closeOthers(appId) {
    closeMany(state.open.filter(function (id) { return id !== appId; }));
  }

  function closeRight(appId) {
    var index = state.open.indexOf(appId);
    if (index < 0) return;
    closeMany(state.open.slice(index + 1));
  }

  function sleepApp(appId) {
    if (!APP_BY_ID[appId]) return false;
    if (!frames.get(appId)) {
      toast('这个标签已经是休眠状态');
      return false;
    }
    destroyFrame(appId);
    appStatus[appId] = 'sleeping';
    appLastActive[appId] = 0;
    delete appMountedAt[appId];
    renderAll();
    save();
    toast('已休眠「' + APP_BY_ID[appId].name + '」，点击标签可唤醒');
    return true;
  }

  function usageTick() {
    if (document.visibilityState !== 'visible') return;
    var appId = paneApp(state.focused);
    if (!appId || appStatus[appId] !== 'ready') return;
    usageEntry(appId).seconds += 60;
    saveUsage();
  }

  function autoSnapTick() {
    var minutes = Number(hubAppearance.snap) || 0;
    if (!minutes || autoSnapBusy) return;
    if (Date.now() - lastAutoSnapAt < minutes * 60000) return;
    var appId = paneApp(state.focused);
    if (!appId || !APP_BY_ID[appId]) return;
    if (appStatus[appId] !== 'ready' || !frames.get(appId)) return;
    lastAutoSnapAt = Date.now();
    autoSnapBusy = true;
    var stamp = new Date().toTimeString().slice(0, 5);
    window.dispatchEvent(
      new CustomEvent('omm:snapshot-request', {
        detail: {
          app: appId,
          label: '定时快照 ' + stamp,
          dedup: true,
          done: function (result) {
            autoSnapBusy = false;
            if (result && result.ok === false && result.error) {
              toast('定时快照失败：' + result.error, 'error');
            }
          },
        },
      })
    );
  }

  function autoSleepTick() {
    var minutes = Number(hubAppearance.sleep) || 0;
    if (!minutes) return;
    var cutoff = Date.now() - minutes * 60000;
    state.open.forEach(function (appId) {
      if (findPaneByApp(appId)) return;
      if (appStatus[appId] !== 'ready') return;
      if (!frames.get(appId)) return;
      if ((appLastActive[appId] || appMountedAt[appId] || 0) < cutoff) {
        destroyFrame(appId);
        appStatus[appId] = 'sleeping';
        delete appMountedAt[appId];
      }
    });
    renderTabs();
    renderDock();
  }

  /* Forget everything about an app so the next open starts it from
     scratch (new files, possibly a new port). */
  function invalidateApp(appId) {
    delete appUrls[appId];
    delete appStatus[appId];
    delete ensurePromises[appId];
    destroyFrame(appId);
  }

  /* Reload an app in place, e.g. after its files were replaced. */
  function reloadApp(appId) {
    invalidateApp(appId);
    var pane = findPaneByApp(appId);
    if (!pane) return;
    state.panes[pane] = appId;
    if (state.open.indexOf(appId) < 0) state.open.push(appId);
    mountApp(appId);
    renderAll();
    save();
  }

  function splitPane(paneId, dir, side, appId) {
    var leaf = findLeafNode(paneId);
    if (!leaf) return;
    var newId = newPaneId();
    state.panes[newId] = null;
    var oldLeaf = { type: 'leaf', id: paneId };
    var newLeaf = { type: 'leaf', id: newId };
    var first = side === 'left' || side === 'top';
    delete leaf.id;
    leaf.type = 'split';
    leaf.dir = dir;
    leaf.ratio = 0.5;
    leaf.key = 's' + ++splitSeq;
    leaf.a = first ? newLeaf : oldLeaf;
    leaf.b = first ? oldLeaf : newLeaf;

    if (appId) {
      var oldPane = findPaneByApp(appId);
      if (oldPane) state.panes[oldPane] = null;
      state.panes[newId] = appId;
      if (state.open.indexOf(appId) < 0) state.open.push(appId);
      mountApp(appId);
    }
    state.maximized = null;
    state.focused = newId;
    renderAll();
    save();
  }

  function splitFocused(dir) {
    var paneId = state.focused || firstLeafId();
    if (!paneId) return;
    splitPane(paneId, dir, dir === 'v' ? 'right' : 'bottom', null);
  }

  function removeLeafFromTree(node, paneId) {
    if (!node) return null;
    if (node.type === 'leaf') return node.id === paneId ? null : node;
    node.a = removeLeafFromTree(node.a, paneId);
    node.b = removeLeafFromTree(node.b, paneId);
    if (!node.a) return node.b;
    if (!node.b) return node.a;
    return node;
  }

  function closePane(paneId) {
    var ids = leafIds(state.tree);
    if (ids.length <= 1) {
      state.panes[paneId] = null;
      renderAll();
      save();
      return;
    }
    state.tree = removeLeafFromTree(state.tree, paneId);
    if (!state.tree) state.tree = { type: 'leaf', id: firstLeafId() || 'p1' };
    delete state.panes[paneId];
    if (state.panes[state.tree.id] === undefined && state.tree.type === 'leaf') {
      state.panes[state.tree.id] = null;
    }
    if (state.focused === paneId) state.focused = firstLeafId();
    if (state.maximized === paneId) state.maximized = null;
    ensureSplitKeys(state.tree);
    renderAll();
    save();
  }

  function setMaximized(on) {
    if (on) {
      if (!state.focused) return;
      state.maximized = state.focused;
    } else {
      state.maximized = null;
    }
    updateToolState();
    renderLayout();
  }

  function applyPreset(kind) {
    if (kind === 'focus') {
      setMaximized(!state.maximized);
      return;
    }
    var current = paneApp(state.focused);
    var ordered = [];
    if (current) ordered.push(current);
    state.open.forEach(function (appId) {
      if (ordered.indexOf(appId) < 0) ordered.push(appId);
    });
    var slots = kind === 'grid' ? 4 : kind === 'single' ? 1 : 2;
    var apps = ordered.slice(0, slots);

    function leaf(id) {
      return { type: 'leaf', id: id };
    }
    function split(dir, a, b) {
      return { type: 'split', dir: dir, ratio: 0.5, key: 's' + ++splitSeq, a: a, b: b };
    }

    var ids = [];
    for (var i = 0; i < slots; i += 1) ids.push(newPaneId());
    state.panes = {};
    ids.forEach(function (id, index) {
      state.panes[id] = apps[index] || null;
    });

    if (kind === 'single') {
      state.tree = leaf(ids[0]);
    } else if (kind === 'v2') {
      state.tree = split('v', leaf(ids[0]), leaf(ids[1]));
    } else if (kind === 'h2') {
      state.tree = split('h', leaf(ids[0]), leaf(ids[1]));
    } else {
      state.tree = split(
        'v',
        split('h', leaf(ids[0]), leaf(ids[1])),
        split('h', leaf(ids[2]), leaf(ids[3]))
      );
    }
    state.focused = ids[0];
    state.maximized = null;
    apps.forEach(function (appId) {
      mountApp(appId);
    });
    renderAll();
    save();
  }

  /* ---------------------------------------------------------------- drop/drag */

  function startDrag(appId) {
    if (!appId) return;
    dragApp = appId;
    document.body.classList.add('dragging-tab');
    els.dropLayer.classList.add('on');
    els.dropHint.classList.remove('on');
  }

  function endDrag() {
    dragApp = null;
    dragTarget = null;
    shareDrag = null;
    document.body.classList.remove('dragging-tab');
    els.dropLayer.classList.remove('on');
    els.dropHint.classList.remove('on');
    document.querySelectorAll('.tab.drag-source').forEach(function (el) {
      el.classList.remove('drag-source');
    });
  }

  function paneAtPoint(clientX, clientY) {
    var box = els.workspace.getBoundingClientRect();
    var x = clientX - box.left;
    var y = clientY - box.top;
    var hit = null;
    layoutRects.forEach(function (rect, paneId) {
      if (hit) return;
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
        hit = { paneId: paneId, rect: rect, x: x, y: y };
      }
    });
    return hit;
  }

  function updateDropHint(event) {
    var hit = paneAtPoint(event.clientX, event.clientY);
    if (!hit) {
      dragTarget = null;
      els.dropHint.classList.remove('on');
      return;
    }
    var rect = hit.rect;
    var relX = (hit.x - rect.x) / Math.max(1, rect.w);
    var relY = (hit.y - rect.y) / Math.max(1, rect.h);
    var zone = 'center';
    if (relX < 0.24) zone = 'left';
    else if (relX > 0.76) zone = 'right';
    else if (relY < 0.24) zone = 'top';
    else if (relY > 0.76) zone = 'bottom';

    var hint = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    var label = '替换此窗格';
    if (zone === 'left') {
      hint.w = rect.w / 2;
      label = '左半屏';
    } else if (zone === 'right') {
      hint.x = rect.x + rect.w / 2;
      hint.w = rect.w / 2;
      label = '右半屏';
    } else if (zone === 'top') {
      hint.h = rect.h / 2;
      label = '上半屏';
    } else if (zone === 'bottom') {
      hint.y = rect.y + rect.h / 2;
      hint.h = rect.h / 2;
      label = '下半屏';
    }
    els.dropHint.style.left = hint.x + 'px';
    els.dropHint.style.top = hint.y + 'px';
    els.dropHint.style.width = hint.w + 'px';
    els.dropHint.style.height = hint.h + 'px';
    els.dropHint.querySelector('span').textContent = label;
    els.dropHint.classList.add('on');
    dragTarget = { paneId: hit.paneId, zone: zone };
  }

  function applyDrop() {
    if (!dragApp || !dragTarget) return;
    var paneId = dragTarget.paneId;
    var zone = dragTarget.zone;
    var appId = dragApp;
    if (zone === 'center') {
      assignApp(paneId, appId);
    } else if (zone === 'left' || zone === 'right') {
      splitPane(paneId, 'v', zone, appId);
    } else {
      splitPane(paneId, 'h', zone, appId);
    }
  }

  function deliverShareDrag(payload, paneId) {
    dragTarget = null;
    els.dropHint.classList.remove('on');
    if (!paneId) {
      toast('请把内容放到某个产品窗格上');
      return;
    }
    var targetApp = paneApp(paneId);
    if (!targetApp || !APP_BY_ID[targetApp]) {
      toast('这个窗格没有产品');
      return;
    }
    var target = { app: targetApp, name: APP_BY_ID[targetApp].name };
    if (!window.OMMShare) {
      toast('共享模块未就绪', 'error');
      return;
    }
    if (payload.kind === 'file' && payload.data) {
      var file = payload.data;
      window.OMMShare
        .publishFile({
          path: file.path,
          name: file.name,
          type: file.mime,
          title: file.name,
          replaceKey: 'drop:' + file.path,
        })
        .then(function (item) {
          return window.OMMShare.openArtifact(item, target);
        });
      return;
    }
    if (payload.data && payload.data.id) {
      window.OMMShare.openArtifact(payload.data, target);
      return;
    }
    toast('这个内容不能拖放，请使用行内的「发送」按钮', 'error');
  }

  /* ---------------------------------------------------------------- context ui */

  function showContextMenu(x, y, appId) {
    var app = appOf(appId);
    if (!app) return;
    closePopovers();
    var open = state.open.indexOf(appId) >= 0;
    els.ctxMenu.innerHTML =
      '<button class="menu-item" type="button" data-ctx="open"><span class="check"></span>打开 / 聚焦</button>' +
      '<button class="menu-item" type="button" data-ctx="right"><span class="check"></span>在右侧分屏</button>' +
      '<button class="menu-item" type="button" data-ctx="bottom"><span class="check"></span>在下方分屏</button>' +
      (open ? '<div class="menu-sep"></div><button class="menu-item" type="button" data-ctx="close"><span class="check"></span>关闭</button>' : '');
    els.ctxMenu.dataset.app = appId;
    els.ctxMenu.hidden = false;
    var width = 172;
    var height = els.ctxMenu.offsetHeight || 120;
    var left = Math.min(x, window.innerWidth - width - 8);
    var top = Math.min(y, window.innerHeight - height - 8);
    els.ctxMenu.style.left = Math.max(8, left) + 'px';
    els.ctxMenu.style.top = Math.max(8, top) + 'px';
    els.ctxMenu.style.right = 'auto';
  }

  function formatTimeShort(value) {
    if (!value) return '';
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  function pushNotify(title, body, options) {
    var opts = options || {};
    notifications.unshift({
      id: 'n' + Date.now() + Math.random().toString(16).slice(2, 6),
      title: title,
      body: body || '',
      kind: opts.kind || 'info',
      app: opts.app || '',
      at: Date.now(),
      read: false,
    });
    notifications = notifications.slice(0, 50);
    notifyUnread += 1;
    renderNotifyBadge();
    if (els.notifyPanel && !els.notifyPanel.hidden) renderNotifyPanel();
  }

  function renderNotifyBadge() {
    var badge = document.getElementById('notify-badge');
    if (badge) {
      badge.hidden = notifyUnread <= 0;
      badge.textContent = notifyUnread > 99 ? '99+' : String(notifyUnread);
    }
    var button = document.getElementById('notify-btn');
    if (button) button.classList.toggle('active', !!(els.notifyPanel && !els.notifyPanel.hidden));
  }

  function notifyTime(ts) {
    var diff = Date.now() - (Number(ts) || 0);
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.round(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.round(diff / 3600000) + ' 小时前';
    return new Date(ts).toLocaleDateString();
  }

  function renderNotifyPanel() {
    var list = document.getElementById('notify-list');
    if (!list) return;
    if (!notifications.length) {
      list.innerHTML =
        '<div class="notify-empty">还没有通知。<br>安装、更新、共享和启动失败都会记录在这里。</div>';
      return;
    }
    list.innerHTML = notifications.map(function (item, index) {
      return (
        '<button class="notify-item' + (item.read ? ' read' : '') + '" type="button" data-notify="' + index + '">' +
        '<span class="notify-dot"></span>' +
        '<span class="notify-meta"><span class="notify-title">' + esc(item.title) + '</span>' +
        (item.body ? '<span class="notify-body">' + esc(item.body) + '</span>' : '') +
        '<span class="notify-time">' + esc(notifyTime(item.at)) + '</span></span></button>'
      );
    }).join('');
  }

  function markNotificationsRead() {
    if (!notifyUnread) return;
    notifications.forEach(function (item) { item.read = true; });
    notifyUnread = 0;
    renderNotifyBadge();
    renderNotifyPanel();
  }

  function toggleNotifyPanel(force) {
    var show = typeof force === 'boolean' ? force : els.notifyPanel.hidden;
    closeCommandPalette();
    closePopovers();
    if (!show) return;
    renderNotifyPanel();
    els.notifyPanel.hidden = false;
    markNotificationsRead();
    renderNotifyBadge();
  }

  function openArchivePane(pane) {
    window.dispatchEvent(
      new CustomEvent('omm:archive', { detail: { action: 'open', pane: pane || 'archive' } })
    );
  }

  function openWorkspaceSaveDialog() {
    closePopovers();
    renderLayoutMenu();
    els.layoutMenu.hidden = false;
    var save = els.layoutMenu.querySelector('[data-ws="save"]');
    if (save) save.click();
  }

  function cmdkActionList() {
    return [
      { label: '打开存档历史', hint: '查看文件与快照', keywords: 'archive cundang', run: function () { openArchivePane('archive'); } },
      { label: '打开跨产品共享', hint: '发送/接收共享内容', keywords: 'share gongxiang', run: function () { openArchivePane('share'); } },
      { label: '插件管理', hint: '安装、更新、卸载、导入', keywords: 'plugin chajian', run: function () { openPluginPanel('installed'); } },
      { label: '外观与设置', hint: '主题、启动、存储与备份', keywords: 'settings shezhi', run: function () { openHubSettings(); } },
      { label: '保存当前布局为工作区', hint: '命名并保存标签与分屏', keywords: 'workspace gongzuoqu', run: function () { openWorkspaceSaveDialog(); } },
      { label: '重置布局', hint: '关闭所有标签，回到单窗格', keywords: 'reset chongzhi', run: function () { resetLayout(true); } },
      { label: '左右双栏', hint: '布局预设', keywords: 'layout shuanglan', run: function () { applyPreset('v2'); } },
      { label: '上下双栏', hint: '布局预设', keywords: 'layout shuanglan', run: function () { applyPreset('h2'); } },
      { label: '四宫格', hint: '布局预设', keywords: 'layout sigongge', run: function () { applyPreset('grid'); } },
      { label: '专注当前窗格', hint: '隐藏其他窗格', keywords: 'focus zhuanzhu', run: function () { applyPreset('focus'); } },
      { label: '显示 / 隐藏 Dock', hint: '底部应用栏', keywords: 'dock', run: function () {
        state.dock = !state.dock;
        applyDockState();
        save();
      } },
      { label: '关闭所有标签', hint: '保留工作台窗口', keywords: 'close guanbi', run: function () { closeAllTabs(true); } },
      { label: '重新打开已关闭标签', hint: 'Ctrl+Shift+T', keywords: 'reopen', run: reopenLastClosed },
      { label: '检查框架更新', hint: '工作台与产品更新', keywords: 'update gengxin', run: function () { openPluginPanel('update'); } },
    ];
  }

  function buildCmdkItems() {
    var items = [];
    APP_LIST.forEach(function (app) {
      items.push({
        group: '应用',
        label: app.name,
        hint: app.description || app.id,
        glyph: app.glyph || '·',
        keywords: app.id + ' ' + (APP_ALIASES[app.id] || ''),
        run: function () { activateApp(app.id); },
      });
    });
    state.open.forEach(function (appId) {
      var app = appOf(appId);
      if (!app) return;
      items.push({
        group: '已打开',
        label: app.name,
        hint: '切换到该标签',
        glyph: app.glyph || '·',
        keywords: app.id + ' tab',
        run: function () { activateApp(appId); },
      });
    });
    cmdkActionList().forEach(function (action) {
      items.push({
        group: '动作',
        label: action.label,
        hint: action.hint || '',
        glyph: '⌘',
        keywords: action.keywords || '',
        run: action.run,
      });
    });
    recentFiles.slice(0, 10).forEach(function (file) {
      items.push({
        group: '最近文件',
        label: file.title,
        hint: (file.app_name || file.app || '') + ' · ' + file.time,
        glyph: '档',
        keywords: (file.name || '') + ' ' + (file.app || ''),
        run: function () { openArchiveFile(file); },
      });
    });
    cmdkShares.slice(0, 10).forEach(function (item) {
      var channel = null;
      (cmdkSpace && cmdkSpace.channels ? cmdkSpace.channels : []).forEach(function (entry) {
        if (entry.id === item.channel) channel = entry;
      });
      var target = channel
        ? (channel.apps || []).filter(function (member) { return member.consume; })[0]
        : null;
      if (!target || !window.OMMShare) return;
      items.push({
        group: '共享项目',
        label: item.title,
        hint: (channel ? channel.name : item.channel) + ' · 在 ' + target.name + ' 中打开',
        glyph: '享',
        keywords: item.source_name || '',
        run: function () { window.OMMShare.openArtifact(item, target); },
      });
    });
    cmdkItems = items;
  }

  function loadCmdkShares() {
    if (cmdkSpace && Date.now() - cmdkSharesAt < 30000) return;
    if (!window.OMMShare) return;
    window.OMMShare.loadSpace()
      .then(function (space) {
        cmdkSpace = space;
        cmdkShares = (space && space.items) || [];
        cmdkSharesAt = Date.now();
        if (cmdkOpen) {
          buildCmdkItems();
          renderCmdk();
        }
      })
      .catch(function () {
        /* share is optional */
      });
  }

  function renderCmdk() {
    if (!els.cmdkList) return;
    var query = (els.cmdkInput.value || '').trim().toLowerCase();
    cmdkFiltered = cmdkItems.filter(function (item) {
      if (!query) return true;
      return (
        item.label + ' ' + (item.hint || '') + ' ' + (item.group || '') + ' ' + (item.keywords || '')
      ).toLowerCase().indexOf(query) >= 0;
    });
    if (cmdkIndex >= cmdkFiltered.length) cmdkIndex = Math.max(0, cmdkFiltered.length - 1);
    if (cmdkIndex < 0) cmdkIndex = 0;
    if (!cmdkFiltered.length) {
      els.cmdkList.innerHTML = '<div class="cmdk-empty">没有匹配的命令或应用。</div>';
      return;
    }
    var groups = ['应用', '已打开', '动作', '最近文件', '共享项目'];
    var html = '';
    groups.forEach(function (group) {
      var groupItems = [];
      cmdkFiltered.forEach(function (item, index) {
        if (item.group === group) groupItems.push({ item: item, index: index });
      });
      if (!groupItems.length) return;
      html += '<div class="cmdk-group">' + group + '</div>';
      groupItems.forEach(function (entry) {
        html +=
          '<button class="cmdk-item' + (entry.index === cmdkIndex ? ' active' : '') +
          '" type="button" data-cmdk="' + entry.index + '">' +
          '<span class="glyph">' + esc(entry.item.glyph || '·') + '</span>' +
          '<span class="label">' + esc(entry.item.label) + '</span>' +
          '<span class="hint">' + esc(entry.item.hint || '') + '</span></button>';
      });
    });
    els.cmdkList.innerHTML = html;
    var active = els.cmdkList.querySelector('.cmdk-item.active');
    if (active) {
      try {
        active.scrollIntoView({ block: 'nearest' });
      } catch (e) {
        /* ignore */
      }
    }
  }

  function runCmdk(index) {
    var item = cmdkFiltered[index];
    if (!item) return;
    closeCommandPalette();
    try {
      item.run();
    } catch (e) {
      toast('操作失败：' + (e && e.message ? e.message : e), 'error');
    }
  }

  function moveCmdk(delta) {
    if (!cmdkFiltered.length) return;
    cmdkIndex = (cmdkIndex + delta + cmdkFiltered.length) % cmdkFiltered.length;
    renderCmdk();
  }

  function openCommandPalette(initial) {
    if (!els.cmdk) return;
    if (cmdkOpen) {
      els.cmdkInput.focus();
      return;
    }
    closePopovers();
    if (els.hubSettings) els.hubSettings.hidden = true;
    closePluginPanel();
    cmdkOpen = true;
    els.cmdk.hidden = false;
    els.cmdkInput.value = initial || '';
    cmdkIndex = 0;
    buildCmdkItems();
    renderCmdk();
    loadCmdkShares();
    loadRecentFiles().then(function () {
      if (!cmdkOpen) return;
      buildCmdkItems();
      renderCmdk();
    });
    setTimeout(function () {
      els.cmdkInput.focus();
      els.cmdkInput.select();
    }, 0);
  }

  function closeCommandPalette() {
    if (!els.cmdk) return;
    cmdkOpen = false;
    els.cmdk.hidden = true;
    els.cmdkInput.value = '';
    cmdkIndex = 0;
  }

  function showTabMenu(x, y, appId) {
    var app = appOf(appId);
    if (!app) return;
    closePopovers();
    var sleeping = appStatus[appId] === 'sleeping';
    els.ctxMenu.dataset.tab = appId;
    delete els.ctxMenu.dataset.app;
    els.ctxMenu.innerHTML =
      '<button class="menu-item" type="button" data-tab-ctx="focus"><span class="check"></span>打开 / 聚焦</button>' +
      '<button class="menu-item" type="button" data-tab-ctx="reload"><span class="check"></span>重新加载</button>' +
      '<button class="menu-item" type="button" data-tab-ctx="sleep"><span class="check"></span>' +
      (sleeping ? '唤醒' : '休眠（释放内存）') +
      '</button>' +
      '<button class="menu-item" type="button" data-tab-ctx="window"><span class="check"></span>在新窗口打开</button>' +
      '<button class="menu-item" type="button" data-tab-ctx="link"><span class="check"></span>复制应用链接</button>' +
      '<div class="menu-sep"></div>' +
      '<button class="menu-item" type="button" data-tab-ctx="move-right"><span class="check"></span>移到右侧分屏</button>' +
      '<button class="menu-item" type="button" data-tab-ctx="move-bottom"><span class="check"></span>移到下方分屏</button>' +
      '<button class="menu-item" type="button" data-tab-ctx="reopen"><span class="check"></span>重新打开已关闭标签</button>' +
      '<div class="menu-sep"></div>' +
      '<button class="menu-item" type="button" data-tab-ctx="close-others"><span class="check"></span>关闭其他</button>' +
      '<button class="menu-item" type="button" data-tab-ctx="close-right"><span class="check"></span>关闭右侧</button>' +
      '<button class="menu-item" type="button" data-tab-ctx="close"><span class="check"></span>关闭</button>';
    els.ctxMenu.hidden = false;
    var width = 196;
    var height = els.ctxMenu.offsetHeight || 230;
    var left = Math.min(x, window.innerWidth - width - 8);
    var top = Math.min(y, window.innerHeight - height - 8);
    els.ctxMenu.style.left = Math.max(8, left) + 'px';
    els.ctxMenu.style.top = Math.max(8, top) + 'px';
    els.ctxMenu.style.right = 'auto';
  }

  function appUrlFor(appId) {
    if (appUrls[appId]) return Promise.resolve(appUrls[appId]);
    return ensureApp(appId);
  }

  function openAppWindow(appId) {
    var app = appOf(appId);
    var name = app ? app.name : appId;
    fetch('/api/window?app=' + encodeURIComponent(appId), { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || '打开失败');
        toast('已在浏览器窗口打开「' + name + '」');
      })
      .catch(function () {
        appUrlFor(appId)
          .then(function (url) {
            window.open(url, '_blank', 'noopener,width=1280,height=860');
            toast('已在新窗口打开「' + name + '」');
          })
          .catch(function (error) {
            toast('打开失败：' + (error && error.message ? error.message : error));
          });
      });
  }

  function copyAppLink(appId) {
    appUrlFor(appId)
      .then(function (url) { return navigator.clipboard.writeText(url); })
      .then(function () { toast('应用链接已复制'); })
      .catch(function (error) {
        toast('复制失败：' + (error && error.message ? error.message : error), 'error');
      });
  }

  function notifyAppError(appId) {
    if (errorNotified[appId]) return;
    errorNotified[appId] = true;
    var app = appOf(appId);
    pushNotify('应用启动失败', (app ? app.name : appId) + '：' + (appErrors[appId] || '本地服务没有响应'), {
      app: appId,
      kind: 'error',
    });
  }

  function checkHealth() {
    fetch('/api/health', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error('本地服务返回异常');
        toast(
          '本地服务正常 · 插件 ' + (data.plugins || []).length + ' 个 · 已启动 ' +
          (data.apps || []).length + ' 个 · 版本 ' + (data.version || '—')
        );
      })
      .catch(function (error) {
        toast('本地服务不可用：' + (error && error.message ? error.message : error), 'error');
      });
  }

  function restoreSnapshotFor(appId) {
    var snap = lastSnapshotByApp[appId];
    if (!snap) {
      toast('这个应用还没有快照', 'error');
      return;
    }
    toast('正在恢复快照并重启应用…');
    window.dispatchEvent(
      new CustomEvent('omm:restore-snapshot', {
        detail: {
          app: appId,
          path: snap.path,
          name: snap.name,
          label: snap.label,
        },
      })
    );
  }

  function copyAppError(appId) {
    var app = appOf(appId);
    var text = (app ? app.name : appId) + '\n' + (appErrors[appId] || '未知错误') + '\n' + location.href;
    var done = function () { toast('错误信息已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { toast('复制失败', 'error'); });
    } else {
      toast(text, 'error');
    }
  }

  function loadRecentFiles(force) {
    if (!force && recentFilesAt && Date.now() - recentFilesAt < 30000) {
      return Promise.resolve(recentFiles);
    }
    return fetch('/__omm/fs/archive?all=1&limit=60', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        lastSnapshotByApp = {};
        (data.entries || []).forEach(function (entry) {
          if (entry.kind !== 'snapshot' || !entry.app) return;
          if (!lastSnapshotByApp[entry.app]) {
            lastSnapshotByApp[entry.app] = {
              path: entry.path,
              name: entry.name || entry.file || '',
              label: entry.label || entry.title || '',
              time: entry.time || entry.updated || '',
            };
          }
        });
        recentFiles = (data.entries || [])
          .filter(function (entry) {
            return entry.kind === 'file' && entry.app && APP_BY_ID[entry.app];
          })
          .slice(0, 20)
          .map(function (entry) {
            return {
              title: entry.name || entry.file || '未命名',
              name: entry.name || entry.file || '',
              app: entry.app || '',
              app_name: entry.app_name || entry.app || '',
              path: entry.path || '',
              mime: entry.mime || '',
              time: formatTimeShort(entry.time || entry.updated || ''),
            };
          });
        recentFilesAt = Date.now();
        refreshEmptyPanes();
        if (cmdkOpen) {
          buildCmdkItems();
          renderCmdk();
        }
        return recentFiles;
      })
      .catch(function () {
        return recentFiles;
      });
  }

  function refreshEmptyPanes() {
    paneEls.forEach(function (el, paneId) {
      if (paneApp(paneId)) return;
      var holder = el.querySelector('.pane-placeholder');
      if (holder) holder.dataset.mode = '';
      updatePaneContent(el, paneId);
    });
  }

  function openArchiveFile(file) {
    if (!file || !file.path) return;
    window.dispatchEvent(
      new CustomEvent('omm:load-file', {
        detail: { app: file.app, path: file.path, name: file.name, mime: file.mime },
      })
    );
  }

  function focusPluginRow(appId) {
    var button = els.ppBody.querySelector('[data-pp-action="open"][data-id="' + appId + '"]');
    if (!button) return;
    var row = button.closest('.pp-row');
    if (!row) return;
    try {
      row.scrollIntoView({ block: 'center' });
    } catch (e) {
      /* ignore */
    }
    row.classList.add('pp-highlight');
    setTimeout(function () { row.classList.remove('pp-highlight'); }, 1600);
  }

  /* ------------------------------------------------------------------- events */

  function bindEvents() {
    /* toolbar */
    els.topbar.addEventListener('pointerdown', syncFocusFromActive, true);
    els.dock.addEventListener('pointerdown', syncFocusFromActive, true);
    els.topbar.addEventListener('click', function (event) {
      var trigger = event.target.closest('[data-act]');
      if (!trigger) return;
      var act = trigger.dataset.act;
      if (act === 'split-v') splitFocused('v');
      else if (act === 'split-h') splitFocused('h');
      else if (act === 'layout') toggleLayoutMenu();
      else if (act === 'focus') setMaximized(!state.maximized);
      else if (act === 'dock') {
        state.dock = !state.dock;
        applyDockState();
        save();
      } else if (act === 'plugins') openPluginPanel();
      else if (act === 'command') openCommandPalette();
      else if (act === 'notify') toggleNotifyPanel();
      else if (act === 'settings') openHubSettings();
      else if (act === 'launcher') toggleLauncher();
      else if (act === 'archive') toggleArchive();
    });
    els.brand.addEventListener('click', function () {
      toggleLauncher();
    });
    if (els.notifyPanel) {
      els.notifyPanel.addEventListener('click', function (event) {
        if (event.target.closest('#notify-clear')) {
          notifications = [];
          notifyUnread = 0;
          renderNotifyBadge();
          renderNotifyPanel();
          return;
        }
        var item = event.target.closest('[data-notify]');
        if (!item) return;
        var note = notifications[Number(item.dataset.notify)];
        if (note && note.app) activateApp(note.app);
        els.notifyPanel.hidden = true;
        renderNotifyBadge();
      });
    }
    els.tabAdd.addEventListener('click', function () {
      toggleLauncher();
    });

    /* tabs */
    els.tabs.addEventListener('click', function (event) {
      var close = event.target.closest('[data-close]');
      if (close) {
        event.stopPropagation();
        closeTab(close.dataset.close);
        return;
      }
      var tab = event.target.closest('.tab[data-app]');
      if (tab) activateApp(tab.dataset.app);
    });
    els.tabs.addEventListener('contextmenu', function (event) {
      var tab = event.target.closest('.tab[data-app]');
      if (!tab) return;
      event.preventDefault();
      showTabMenu(event.clientX, event.clientY, tab.dataset.app);
    });
    els.tabs.addEventListener('auxclick', function (event) {
      if (event.button !== 1) return;
      var tab = event.target.closest('.tab[data-app]');
      if (!tab) return;
      event.preventDefault();
      closeTab(tab.dataset.app);
    });
    var overflowButton = document.getElementById('tabs-overflow');
    if (overflowButton) {
      overflowButton.addEventListener('click', function () {
        toggleTabsMore();
      });
    }
    var tabsMore = document.getElementById('tabs-more');
    if (tabsMore) {
      tabsMore.addEventListener('click', function (event) {
        var item = event.target.closest('[data-more]');
        if (!item) return;
        activateApp(item.dataset.more);
        tabsMore.hidden = true;
      });
    }
    /* drag over the tab bar = reorder instead of splitting */
    els.tabs.addEventListener('dragover', function (event) {
      if (!dragApp) return;
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = 'move';
      } catch (e) {
        /* ignore */
      }
    });
    els.tabs.addEventListener('drop', function (event) {
      if (!dragApp) return;
      event.preventDefault();
      event.stopPropagation();
      reorderTabs(dragApp, tabInsertIndexFromEvent(event));
      endDrag();
    });
    els.tabs.addEventListener('auxclick', function (event) {
      if (event.button !== 1) return;
      var tab = event.target.closest('.tab[data-app]');
      if (tab) {
        event.preventDefault();
        closeTab(tab.dataset.app);
      }
    });
    els.tabs.addEventListener('dragstart', function (event) {
      var tab = event.target.closest('.tab[data-app]');
      if (!tab) return;
      tab.classList.add('drag-source');
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tab.dataset.app);
      } catch (e) {
        /* ignore */
      }
      startDrag(tab.dataset.app);
    });
    els.tabs.addEventListener('dragend', endDrag);
    els.tabs.addEventListener(
      'wheel',
      function (event) {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        els.tabs.scrollLeft += event.deltaY;
      },
      { passive: false }
    );

    /* dock */
    els.dock.addEventListener('click', function (event) {
      var utility = event.target.closest('[data-act="launcher"]');
      if (utility) {
        toggleLauncher();
        return;
      }
      var item = event.target.closest('.dock-app[data-app]');
      if (item) activateApp(item.dataset.app);
    });
    els.dock.addEventListener('contextmenu', function (event) {
      var item = event.target.closest('.dock-app[data-app]');
      if (!item) return;
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, item.dataset.app);
    });
    els.dock.addEventListener('dragstart', function (event) {
      var item = event.target.closest('.dock-app[data-app]');
      if (!item) return;
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.dataset.app);
      } catch (e) {
        /* ignore */
      }
      startDrag(item.dataset.app);
    });
    els.dock.addEventListener('dragend', endDrag);
    els.dock.addEventListener(
      'wheel',
      function (event) {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        els.dock.scrollLeft += event.deltaY;
      },
      { passive: false }
    );

    /* launcher */
    els.launcher.addEventListener('click', function (event) {
      var pin = event.target.closest('[data-pin]');
      if (pin) {
        event.preventDefault();
        event.stopPropagation();
        togglePin(pin.dataset.pin);
        return;
      }
      var item = event.target.closest('.launcher-app[data-app], .launcher-chip[data-app]');
      if (!item) return;
      activateApp(item.dataset.app);
      toggleLauncher(false);
    });
    els.launcher.addEventListener('compositionstart', function (event) {
      if (event.target && event.target.id === 'launcher-search') launcherComposing = true;
    });
    els.launcher.addEventListener('compositionend', function (event) {
      if (!event.target || event.target.id !== 'launcher-search') return;
      launcherComposing = false;
      launcherQuery = event.target.value || '';
      launcherIndex = 0;
      renderLauncher(true);
    });
    els.launcher.addEventListener('input', function (event) {
      if (!event.target || event.target.id !== 'launcher-search') return;
      if (launcherComposing) return;
      launcherQuery = event.target.value || '';
      launcherIndex = 0;
      renderLauncher(true);
    });
    els.launcher.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveLauncher(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter') {
        var active = els.launcher.querySelector('.launcher-app.active');
        if (!active) return;
        event.preventDefault();
        activateApp(active.dataset.app);
        toggleLauncher(false);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        toggleLauncher(false);
      }
    });

    /* layout menu */
    els.layoutMenu.addEventListener('click', function (event) {
      var item = event.target.closest('[data-preset]');
      if (item) {
        applyPreset(item.dataset.preset);
        els.layoutMenu.hidden = true;
        return;
      }
      var apply = event.target.closest('[data-ws-apply]');
      if (apply) {
        applyWorkspace(apply.dataset.wsApply);
        els.layoutMenu.hidden = true;
        return;
      }
      var remove = event.target.closest('[data-ws-del]');
      if (remove) {
        event.stopPropagation();
        deleteWorkspace(remove.dataset.wsDel);
        return;
      }
      var action = event.target.closest('[data-ws]');
      if (!action) return;
      var kind = action.dataset.ws;
      var form = document.getElementById('ws-save');
      var input = document.getElementById('ws-name');
      if (kind === 'save') {
        if (form) form.hidden = false;
        if (input) {
          input.value = '';
          input.focus();
        }
      } else if (kind === 'commit') {
        if (input && saveCurrentWorkspace(input.value) && form) form.hidden = true;
      } else if (kind === 'cancel') {
        if (form) form.hidden = true;
      }
    });
    els.layoutMenu.addEventListener('keydown', function (event) {
      if (!event.target || event.target.id !== 'ws-name') return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (saveCurrentWorkspace(event.target.value)) {
          var form = document.getElementById('ws-save');
          if (form) form.hidden = true;
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        var box = document.getElementById('ws-save');
        if (box) box.hidden = true;
      }
    });

    /* context menu */
    els.ctxMenu.addEventListener('click', function (event) {
      var tabItem = event.target.closest('[data-tab-ctx]');
      if (tabItem) {
        var tabApp = els.ctxMenu.dataset.tab;
        var tabAction = tabItem.dataset.tabCtx;
        els.ctxMenu.hidden = true;
        if (!tabApp) return;
        if (tabAction === 'focus') activateApp(tabApp);
        else if (tabAction === 'reload') reloadApp(tabApp);
        else if (tabAction === 'sleep') {
          if (appStatus[tabApp] === 'sleeping') activateApp(tabApp);
          else sleepApp(tabApp);
        } else if (tabAction === 'window') openAppWindow(tabApp);
        else if (tabAction === 'link') copyAppLink(tabApp);
        else if (tabAction === 'move-right') {
          var pane = findPaneByApp(tabApp) || state.focused;
          if (pane) splitPane(pane, 'v', 'right', tabApp);
        } else if (tabAction === 'move-bottom') {
          var pane2 = findPaneByApp(tabApp) || state.focused;
          if (pane2) splitPane(pane2, 'h', 'bottom', tabApp);
        } else if (tabAction === 'reopen') reopenLastClosed();
        else if (tabAction === 'close-others') closeOthers(tabApp);
        else if (tabAction === 'close-right') closeRight(tabApp);
        else if (tabAction === 'close') closeTab(tabApp);
        return;
      }
      var item = event.target.closest('[data-ctx]');
      if (!item) return;
      var appId = els.ctxMenu.dataset.app;
      var action = item.dataset.ctx;
      els.ctxMenu.hidden = true;
      if (action === 'open') activateApp(appId);
      else if (action === 'right') splitPane(state.focused, 'v', 'right', appId);
      else if (action === 'bottom') splitPane(state.focused, 'h', 'bottom', appId);
      else if (action === 'close') closeTab(appId);
    });

    /* command palette */
    if (els.cmdk && els.cmdkInput) {
      els.cmdkInput.addEventListener('input', function () {
        cmdkIndex = 0;
        renderCmdk();
      });
      els.cmdkInput.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveCmdk(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          runCmdk(cmdkIndex);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeCommandPalette();
        }
      });
      els.cmdk.addEventListener('click', function (event) {
        if (event.target === els.cmdk) {
          closeCommandPalette();
          return;
        }
        var item = event.target.closest('[data-cmdk]');
        if (item) runCmdk(Number(item.dataset.cmdk));
      });
    }

    /* plugin panel */
    var ppClose = document.getElementById('pp-close');
    if (ppClose) ppClose.addEventListener('click', closePluginPanel);
    if (els.pluginPanel) {
      els.pluginPanel.addEventListener('click', function (event) {
        if (event.target === els.pluginPanel) closePluginPanel();
      });
      Array.prototype.forEach.call(
        els.pluginPanel.querySelectorAll('[data-pp-tab]'),
        function (el) {
          el.addEventListener('click', function () {
            setPluginTab(el.dataset.ppTab);
          });
        }
      );
    }
    if (els.ppBody) {
      els.ppBody.addEventListener('keydown', function (event) {
        if (!pluginDirEditing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          applyPluginDir();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          pluginDirEditing = false;
          renderPluginPanel();
        }
      });
      els.ppBody.addEventListener('click', function (event) {
        var action = event.target.closest('[data-pp-action]');
        if (!action) return;
        var id = action.dataset.id;
        var name = action.dataset.ppAction;
        if (name === 'install') installOnlinePlugin(id);
        else if (name === 'remove') removePlugin(id);
        else if (name === 'open') {
          closePluginPanel();
          activateApp(id);
        } else if (name === 'reload-catalog') {
          catalogCache = null;
          catalogError = '';
          renderPluginPanel();
        } else if (name === 'check-update') {
          /* Re-check both the framework and every plugin version. */
          updateInfo = null;
          catalogCache = null;
          catalogError = '';
          renderUpdatePanel();
        } else if (name === 'apply-update') {
          applyHubUpdate();
        } else if (name === 'download-update') {
          downloadHubUpdate();
        } else if (name === 'pick-file') {
          var input = document.getElementById('pp-file');
          if (input) input.click();
        } else if (name === 'show-spec') {
          setPluginTab('spec');
        } else if (name === 'change-dir') {
          pluginDirEditing = true;
          renderPluginPanel();
          var box = document.getElementById('pp-dir-input');
          if (box) {
            box.focus();
            box.select();
          }
        } else if (name === 'cancel-dir') {
          pluginDirEditing = false;
          renderPluginPanel();
        } else if (name === 'save-dir') {
          applyPluginDir();
        }
      });
    }

    /* panes */
    els.paneLayer.addEventListener('pointerdown', function (event) {
      var pane = event.target.closest('.pane');
      if (pane) setFocused(pane.dataset.pane);
    });
    els.paneLayer.addEventListener('click', function (event) {
      var pane = event.target.closest('.pane');
      if (!pane) return;
      var paneId = pane.dataset.pane;
      var tile = event.target.closest('.app-tile[data-app]');
      if (tile) {
        assignApp(paneId, tile.dataset.app);
        return;
      }
      var retry = event.target.closest('[data-act="retry"]');
      if (retry) {
        retryApp(retry.dataset.app);
        return;
      }
      var recent = event.target.closest('[data-recent]');
      if (recent) {
        var file = recentFiles[Number(recent.dataset.recent)];
        if (file) openArchiveFile(file);
        return;
      }
      var action = event.target.closest('[data-act]');
      if (!action) return;
      if (action.dataset.act === 'open-plugins') openPluginPanel('online');
      else if (action.dataset.act === 'pane-split-v') splitPane(paneId, 'v', 'right', null);
      else if (action.dataset.act === 'pane-split-h') splitPane(paneId, 'h', 'bottom', null);
      else if (action.dataset.act === 'pane-close') closePane(paneId);
      else if (action.dataset.act === 'wake') activateApp(action.dataset.app);
      else if (action.dataset.act === 'open-plugin') {
        openPluginPanel('installed');
        focusPluginRow(action.dataset.app);
      } else if (action.dataset.act === 'health') checkHealth();
      else if (action.dataset.act === 'copy-error') copyAppError(action.dataset.app);
    });

    /* splitters */
    els.splitterLayer.addEventListener('pointerdown', function (event) {
      var el = event.target.closest('.splitter');
      if (!el) return;
      var node = el._node;
      if (!node || !el._region) return;
      resizeState = {
        el: el,
        node: node,
        region: el._region,
        dir: node.dir,
        pointerId: event.pointerId,
      };
      el.classList.add('dragging');
      document.body.classList.add('resizing');
      document.body.dataset.resizeDir = node.dir;
      try {
        el.setPointerCapture(event.pointerId);
      } catch (e) {
        /* ignore */
      }
      event.preventDefault();
    });
    els.splitterLayer.addEventListener('dblclick', function (event) {
      var el = event.target.closest('.splitter');
      if (!el || !el._node) return;
      el._node.ratio = 0.5;
      renderLayout();
      save();
    });

    /* drop layer */
    els.dropLayer.addEventListener('dragover', function (event) {
      if (!dragApp && !shareDrag) return;
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = shareDrag ? 'copy' : 'move';
      } catch (e) {
        /* ignore */
      }
      if (shareDrag) {
        els.dropHint.classList.add('on');
        els.dropHint.querySelector('span').textContent = '松开：发送到该窗格的产品';
        var hit = paneAtPoint(event.clientX, event.clientY);
        dragTarget = hit ? { paneId: hit.paneId, zone: 'center' } : null;
        return;
      }
      updateDropHint(event);
    });
    els.dropLayer.addEventListener('dragleave', function (event) {
      if (event.relatedTarget && els.dropLayer.contains(event.relatedTarget)) return;
      dragTarget = null;
      els.dropHint.classList.remove('on');
    });
    /* Share/archive rows announce themselves on window-level drag events. */
    window.addEventListener('dragenter', function (event) {
      var kinds = event.dataTransfer ? event.dataTransfer.types : [];
      if (!kinds || !kinds.length) return;
      for (var i = 0; i < kinds.length; i++) {
        if (kinds[i] === 'application/x-omm-item' || kinds[i] === 'application/x-omm-file') {
          shareDrag = { kind: kinds[i] === 'application/x-omm-file' ? 'file' : 'item' };
          els.dropLayer.classList.add('on');
          return;
        }
      }
    });
    window.addEventListener('dragend', function () {
      shareDrag = null;
    });
    els.dropLayer.addEventListener('drop', function (event) {
      event.preventDefault();
      if (shareDrag) {
        var payload = { kind: shareDrag.kind, data: null };
        try {
          var raw =
            event.dataTransfer.getData('application/x-omm-item') ||
            event.dataTransfer.getData('application/x-omm-file');
          if (raw) payload.data = JSON.parse(raw);
        } catch (e) {
          /* malformed payload: treated as empty below */
        }
        updateDropHint(event);
        var paneId = dragTarget && dragTarget.paneId;
        endDrag();
        deliverShareDrag(payload, paneId);
        return;
      }
      updateDropHint(event);
      applyDrop();
      endDrag();
    });

    /* resize splitters */
    window.addEventListener('pointermove', function (event) {
      if (!resizeState) return;
      var item = resizeState;
      var region = item.region;
      var usable = item.dir === 'v' ? region.w - SPLIT : region.h - SPLIT;
      if (usable <= 0) return;
      var pos =
        item.dir === 'v' ? event.clientX - region.x : event.clientY - region.y;
      var min = item.dir === 'v' ? MIN_W : MIN_H;
      var minRatio = Math.min(0.45, min / usable);
      var ratio = pos / usable;
      ratio = Math.max(minRatio, Math.min(1 - minRatio, ratio));
      item.node.ratio = ratio;
      renderLayout();
    });
    window.addEventListener('pointerup', function () {
      if (!resizeState) return;
      resizeState.el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      delete document.body.dataset.resizeDir;
      resizeState = null;
      save();
    });
    window.addEventListener('pointercancel', function () {
      if (!resizeState) return;
      resizeState.el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      delete document.body.dataset.resizeDir;
      resizeState = null;
    });

    /* iframe focus sync */
    window.addEventListener('blur', function () {
      window.setTimeout(function () {
        var active = document.activeElement;
        if (active && active.tagName === 'IFRAME' && active.dataset.app) {
          var pane = findPaneByApp(active.dataset.app);
          if (pane) setFocused(pane);
        }
      }, 0);
    });

    /* clicking outside popovers */
    document.addEventListener('pointerdown', function (event) {
      if (
        event.target.closest('#launcher') ||
        event.target.closest('#layout-menu') ||
        event.target.closest('#ctx-menu') ||
        event.target.closest('#notify-panel') ||
        event.target.closest('#notify-btn') ||
        event.target.closest('#tabs-more') ||
        event.target.closest('#tabs-overflow') ||
        event.target.closest('#brand') ||
        event.target.closest('#tab-add') ||
        event.target.closest('[data-act="layout"]') ||
        event.target.closest('[data-act="launcher"]')
      ) {
        return;
      }
      if (
        !els.launcher.hidden ||
        !els.layoutMenu.hidden ||
        !els.ctxMenu.hidden ||
        (els.notifyPanel && !els.notifyPanel.hidden) ||
        (els.tabsMore && !els.tabsMore.hidden)
      ) {
        closePopovers();
      }
    });
    els.launcher.addEventListener('contextmenu', function (event) {
      event.preventDefault();
    });

    /* keyboard */
    window.addEventListener('keydown', onKeyDown, true);

    /* The archive panel asks for the focused product when it opens. */
    window.addEventListener('omm:focus-request', function () {
      broadcastFocus(paneApp(state.focused), true);
    });

    /* messages forwarded from product iframes */
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || !data.type) return;
      var sourceFrame = null;
      frames.forEach(function (frame) {
        if (!sourceFrame && frame.contentWindow === event.source) sourceFrame = frame;
      });
      if (!sourceFrame) return;
      var sourceApp = sourceFrame.dataset.app;

      if (data.type === 'omm:ready') {
        sourceFrame.dataset.ready = '1';
        return;
      }
      if (data.type === 'omm:snapshot-done') {
        var done = pendingSnapshots[data.token];
        delete pendingSnapshots[data.token];
        if (done) done(data);
        return;
      }
      if (data.type === 'omm:restore-accepted') {
        delete pendingRestores[data.token];
        return;
      }
      if (data.type === 'omm:share-open') {
        openSharedApp(appIdFromMessage(data.app));
        return;
      }
      if (data.type === 'omm:saved') {
        window.dispatchEvent(new CustomEvent('omm:archive-refresh'));
        loadRecentFiles(true);
        return;
      }
      if (data.type === 'omm:shared-received') {
        var targetApp = appIdFromMessage(data.app) || sourceApp;
        var targetName = appOf(targetApp) ? appOf(targetApp).name : targetApp;
        shareBadges[targetApp] = (shareBadges[targetApp] || 0) + 1;
        renderTabs();
        renderDock();
        pushNotify(
          '收到共享内容',
          '「' + targetName + '」收到：' + (data.title || '共享项目'),
          { app: targetApp, kind: 'share' }
        );
        return;
      }
      if (data.type === 'omm:pointerdown') {
        /* A click anywhere outside the archive panel dismisses it, including
           clicks inside a product iframe (they never reach this document). */
        if (
          !els.launcher.hidden ||
          !els.layoutMenu.hidden ||
          !els.ctxMenu.hidden ||
          (els.notifyPanel && !els.notifyPanel.hidden)
        ) {
          closePopovers();
        }
        window.dispatchEvent(new CustomEvent('omm:archive', { detail: { action: 'close' } }));
        return;
      }
      if (data.type !== 'omm:shortcut') return;
      if (sourceApp) {
        var pane = findPaneByApp(sourceApp);
        if (pane) setFocused(pane);
      }
      handleShortcut(data.action, data);
    });
  }

  function appIdFromMessage(value) {
    return String(value || '').replace(/^omm-/, '').trim();
  }

  function onKeyDown(event) {
    var mod = event.ctrlKey || event.metaKey;
    if (!mod) {
      if (event.key === 'Escape') {
        if (cmdkOpen) {
          closeCommandPalette();
          event.preventDefault();
        } else if (!els.hubSettings.hidden) {
          closeHubSettings();
          event.preventDefault();
        } else if (!els.pluginPanel.hidden) {
          closePluginPanel();
          event.preventDefault();
        } else if (!els.ctxMenu.hidden || !els.layoutMenu.hidden || launcherOpen) {
          closePopovers();
          event.preventDefault();
        } else if (state.maximized) {
          setMaximized(false);
          event.preventDefault();
        }
      }
      return;
    }

    var key = event.key;
    var lower = (key || '').toLowerCase();
    var action = null;
    var extra = null;

    if (event.altKey && /^[1-9]$/.test(key)) {
      var saved = loadWorkspaces();
      var targetWorkspace = saved[parseInt(key, 10) - 1];
      if (targetWorkspace) {
        applyWorkspace(targetWorkspace.id);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (key === 'Tab') action = event.shiftKey ? 'prev-tab' : 'next-tab';
    else if (lower === 'w') action = 'close-tab';
    else if (lower === 'k') action = 'command-palette';
    else if (lower === 't' && event.shiftKey) action = 'reopen-tab';
    else if (lower === 'n' && event.shiftKey) action = 'notify-panel';
    else if (key === '\\' || key === '|') action = event.shiftKey ? 'split-h' : 'split-v';
    else if (lower === 'd' && event.shiftKey) action = 'toggle-dock';
    else if (lower === 'm' && event.shiftKey) action = 'focus-pane';
    else if (key === '0') action = 'open-index', (extra = { index: 0 });
    else if (/^[1-9]$/.test(key)) action = 'open-index', (extra = { index: parseInt(key, 10) });

    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    handleShortcut(action, extra || {});
  }

  function handleShortcut(action, data) {
    if (action === 'command-palette') openCommandPalette();
    else if (action === 'reopen-tab') reopenLastClosed();
    else if (action === 'notify-panel') toggleNotifyPanel();
    else if (action === 'next-tab') cycleTab(1);
    else if (action === 'prev-tab') cycleTab(-1);
    else if (action === 'close-tab') {
      var app = paneApp(state.focused);
      if (app) closeTab(app);
    } else if (action === 'split-v') splitFocused('v');
    else if (action === 'split-h') splitFocused('h');
    else if (action === 'toggle-dock') {
      state.dock = !state.dock;
      applyDockState();
      save();
    } else if (action === 'focus-pane') setMaximized(!state.maximized);
    else if (action === 'open-index') {
      var index = data && typeof data.index === 'number' ? data.index : -1;
      if (index === 0) toggleLauncher();
      else if (index > 0 && APP_LIST[index - 1]) activateApp(APP_LIST[index - 1].id);
    }
  }

  function cycleTab(delta) {
    if (!state.open.length) return;
    var current = paneApp(state.focused);
    var index = current ? state.open.indexOf(current) : -1;
    var next = (index + delta + state.open.length) % state.open.length;
    activateApp(state.open[next]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
