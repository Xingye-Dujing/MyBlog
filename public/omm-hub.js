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
  var SCREEN_KEY_PREFIX = 'omm.hub.screen-layout.v1.';
  var DEFAULT_CUSTOM_HEX = '#FF8FC8';
  var ACCENT_HEX_HINT = '支持 #RGB / #RRGGBB，例如 #FF8FC8；深色主题会自动提亮。';
  /* Allowed values for the "定时快照" interval (in minutes). Shared by the
     settings dropdown, the persisted-appearance whitelist and backup restore.
     Keep in sync with the <option> list in omm-hub.html. */
  var SNAP_INTERVALS = [0, 5, 10, 15, 30, 45, 60, 120, 240, 360, 720, 1440];

  /* 可自定义快捷键的命令表。默认组合与 README / 设置页里的快捷键列表一致。 */
  var COMMANDS = [
    { id: 'next-tab', label: '下一个标签', def: 'Ctrl+Tab' },
    { id: 'prev-tab', label: '上一个标签', def: 'Ctrl+Shift+Tab' },
    { id: 'close-tab', label: '关闭当前标签', def: 'Ctrl+W' },
    { id: 'command-palette', label: '命令面板', def: 'Ctrl+K' },
    { id: 'global-search', label: '全局内容搜索', def: 'Ctrl+Shift+F' },
    { id: 'knowledge-graph', label: '知识图谱', def: '' },
    { id: 'data-flow', label: '数据流', def: '' },
    { id: 'zen-mode', label: '静心专注', def: 'Ctrl+Shift+Z' },
    { id: 'reopen-tab', label: '重开关闭的标签', def: 'Ctrl+Shift+T' },
    { id: 'notify-panel', label: '通知中心', def: 'Ctrl+Shift+N' },
    { id: 'split-v', label: '左右分屏', def: 'Ctrl+\\' },
    { id: 'split-h', label: '上下分屏', def: 'Ctrl+Shift+\\' },
    { id: 'toggle-dock', label: '显示 / 隐藏 Dock', def: 'Ctrl+Shift+D' },
    { id: 'focus-pane', label: '专注当前窗格', def: 'Ctrl+Shift+M' },
    { id: 'open-0', label: '所有应用', def: 'Ctrl+0' },
  ];
  for (var _i = 1; _i <= 9; _i++) {
    COMMANDS.push({ id: 'open-' + _i, label: '打开第 ' + _i + ' 个应用', def: 'Ctrl+' + _i });
  }
  var DEFAULT_KEYMAP = {};
  COMMANDS.forEach(function (cmd) { DEFAULT_KEYMAP[cmd.id] = cmd.def; });

  function snapIntervalLabel(minutes) {
    minutes = Number(minutes) || 0;
    if (minutes < 60) return '每 ' + minutes + ' 分钟';
    if (minutes < 1440) return '每 ' + (minutes / 60) + ' 小时';
    return '每 ' + (minutes / 1440) + ' 天';
  }
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
    focus: { pomodoro: 25, breakMin: 5, sound: 'none', dim: true, dnd: true },
    keymap: {},
    macros: [],
    a11y: { fontScale: 1, highContrast: false, reduceMotion: false, ariaLabels: true },
    multiMonitor: true,
    cloud: { enabled: false, url: '', user: '', password: '', schedule: 'manual', lastAt: 0 },
  };

  function normalizeCloud(raw) {
    var data = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: data.enabled === true,
      url: typeof data.url === 'string' ? data.url : '',
      user: typeof data.user === 'string' ? data.user : '',
      password: typeof data.password === 'string' ? data.password : '',
      schedule: ['manual', 'daily', 'weekly'].indexOf(data.schedule) >= 0 ? data.schedule : 'manual',
      lastAt: Number(data.lastAt) || 0,
    };
  }

  function normalizeA11y(raw) {
    var data = raw && typeof raw === 'object' ? raw : {};
    var scale = Number(data.fontScale);
    return {
      fontScale: isFinite(scale) && scale >= 0.8 && scale <= 1.6 ? Math.round(scale * 100) / 100 : 1,
      highContrast: data.highContrast === true,
      reduceMotion: data.reduceMotion === true,
      ariaLabels: data.ariaLabels !== false,
    };
  }

  function normalizeKeymap(raw) {
    var out = {};
    var src = raw && typeof raw === 'object' ? raw : {};
    COMMANDS.forEach(function (cmd) {
      var value = typeof src[cmd.id] === 'string' ? src[cmd.id].trim() : '';
      out[cmd.id] = value || cmd.def;
    });
    return out;
  }

  function normalizeMacros(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (m) {
      return m && typeof m.name === 'string' && m.name.trim() && Array.isArray(m.actions);
    }).slice(0, 20).map(function (m) {
      return {
        name: m.name.trim().slice(0, 40),
        key: typeof m.key === 'string' ? m.key.trim() : '',
        actions: m.actions.filter(function (a) { return typeof a === 'string'; }).slice(0, 12),
      };
    });
  }

  function normalizeFocus(raw) {
    var data = raw && typeof raw === 'object' ? raw : {};
    function num(value, fallback, min, max) {
      var n = Number(value);
      return isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
    }
    return {
      pomodoro: num(data.pomodoro, 25, 1, 180),
      breakMin: num(data.breakMin, 5, 1, 60),
      sound: ['none', 'rain', 'noise', 'coffee'].indexOf(data.sound) >= 0 ? data.sound : 'none',
      dim: data.dim !== false,
      dnd: data.dnd !== false,
    };
  }

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
  var gsearchOpen = false;
  var gsearchTimer = 0;
  var gsearchSeq = 0;
  var gsearchResults = [];
  var gsearchIndex = 0;
  var zenActive = false;
  var zenRunning = false;
  var zenPhase = 'focus';
  var zenRemaining = 0;
  var zenTotal = 0;
  var zenTimer = 0;
  var zenAudio = null;
  var zenSource = null;
  var zenNodes = [];
  var aiSavedKey = '';
  var aiConfigPromise = null;
  var timelineOpen = false;
  var timelineFilter = 'all';
  var timelineEvents = [];
  var graphOpen = false;
  var graphCards = [];
  var graphSeq = 0;
  var graphPos = [];
  var flowOpen = false;
  var todayOpen = false;
  var flowEvents = [];
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

  var LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];

  function isLoopbackOrigin(origin) {
    try {
      var u = new URL(String(origin || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return LOOPBACK_HOSTS.indexOf(u.hostname) >= 0;
    } catch (e) {
      return false;
    }
  }

  /* 产品 iframe 由各插件在独立的 loopback 端口上提供服务，与工作台并不同源。
     目标 origin 必须从该 iframe 自己的 URL 推导，不能写死 location.origin。 */
  function frameTargetOrigin(frame) {
    try {
      var raw = frame && (frame.dataset.url || frame.src);
      if (raw && raw !== 'about:blank') {
        var origin = new URL(raw, window.location.href).origin;
        if (isLoopbackOrigin(origin)) return origin;
      }
    } catch (e) {
      /* ignore */
    }
    return window.location.origin;
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

  function screenKey() {
    try {
      var s = window.screen || {};
      return [s.width, s.height, s.availLeft || 0, s.availTop || 0].join('x');
    } catch (e) { return 'default'; }
  }

  function applyDetachAndScreenLayout() {
    try {
      var params = new URLSearchParams(window.location.search);
      var detach = params.get('detach');
      if (detach && APP_BY_ID[detach]) {
        state.open = [detach];
        state.tree = { type: 'leaf', id: 'p1' };
        state.panes = { p1: detach };
        state.focused = 'p1';
        state.maximized = null;
        return;
      }
      if (hubAppearance.multiMonitor === false) return;
      var raw = localStorage.getItem(SCREEN_KEY_PREFIX + screenKey());
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || !data.tree || !data.panes) return;
      state.open = Array.isArray(data.open)
        ? data.open.filter(function (id) { return !!APP_BY_ID[id]; }) : [];
      state.tree = data.tree;
      state.panes = data.panes;
      state.focused = data.focused && data.panes[data.focused] ? data.focused : 'p1';
      state.maximized = data.maximized || null;
      if (typeof data.dock === 'boolean') state.dock = data.dock;
    } catch (e) { /* 忽略损坏的布局 */ }
  }

  function saveScreenLayout() {
    if (hubAppearance.multiMonitor === false) return;
    try {
      var payload = {
        open: state.open, tree: state.tree, panes: state.panes,
        focused: state.focused, maximized: state.maximized, dock: state.dock,
      };
      localStorage.setItem(SCREEN_KEY_PREFIX + screenKey(), JSON.stringify(payload));
    } catch (e) { /* ignore */ }
  }

  function detachApp(appId) {
    if (!appId) return;
    var app = appOf(appId);
    fetch('/api/detach?app=' + encodeURIComponent(appId), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.ok) throw new Error('detach failed');
        toast('已在新窗口打开“' + (app ? app.name : appId) + '”');
      })
      .catch(function () {
        var url = 'omm-hub.html?detach=' + encodeURIComponent(appId);
        window.open(url, '_blank');
      });
  }

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
    els.gsearch = document.getElementById('global-search');
    els.gsearchInput = document.getElementById('gsearch-input');
    els.gsearchList = document.getElementById('gsearch-list');
    els.gsearchMeta = document.getElementById('gsearch-meta');
    els.knowledgeGraph = document.getElementById('knowledge-graph');
    els.kgCanvas = document.getElementById('kg-canvas');
    els.kgDetail = document.getElementById('kg-detail');
    els.kgList = document.getElementById('kg-list');
    els.kgStatus = document.getElementById('kg-status');
    els.dataFlow = document.getElementById('data-flow');
    els.flowChannels = document.getElementById('flow-channels');
    els.flowEventList = document.getElementById('flow-event-list');
    els.flowStatus = document.getElementById('flow-status');
    els.todayPanel = document.getElementById('today-panel');
    els.todayBody = document.getElementById('today-body');
    els.todayStatus = document.getElementById('today-status');
    els.zenBar = document.getElementById('zen-bar');
    els.zenProgress = document.getElementById('zen-progress');
    els.zenClock = document.getElementById('zen-clock');
    els.zenModeLabel = document.getElementById('zen-mode-label');
    els.zenHint = document.getElementById('zen-hint');
    els.zenToggle = document.getElementById('zen-toggle');
    els.zenSkip = document.getElementById('zen-skip');
    els.zenSound = document.getElementById('zen-sound');
    els.zenExit = document.getElementById('zen-exit');
    els.timelinePanel = document.getElementById('timeline-panel');
    els.timelineList = document.getElementById('timeline-list');
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
      cloudAutoTick();
    }, 60000);

    if (window.ResizeObserver) {
      new ResizeObserver(scheduleLayout).observe(els.workspace);
    }
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('beforeunload', saveNow);
    window.addEventListener('pagehide', saveNow);
    window.addEventListener('beforeunload', saveScreenLayout);
    window.addEventListener('pagehide', saveScreenLayout);
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
          applyDetachAndScreenLayout();
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
      // 必须确认 iframe 已真正 ready，否则消息会发给尚未载入的 document；
      // 之前的 2.6s 兜底会让下方的 20s 超时分支永远不可达。
      if (frame && frame.contentWindow && frame.dataset.ready === '1') {
        callback(frame);
        return;
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
            frameTargetOrigin(frame)
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
        frameTargetOrigin(frame)
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
            frameTargetOrigin(frame)
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
    toast(existing ? '已更新工作区“' + text + '”' : '已保存工作区“' + text + '”');
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
    toast('已切换到工作区“' + workspace.name + '”');
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
        : '<div class="launcher-empty">没有匹配“' + esc(query) + '”的应用。<br>试试名称、描述或拼音首字母。</div>';
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
      hubAppearance.snap = SNAP_INTERVALS.indexOf(Number(data.snap)) >= 0
        ? Number(data.snap)
        : 0;
      hubAppearance.dockSort = data.dockSort === 'usage' ? 'usage' : 'fixed';
      hubAppearance.focus = normalizeFocus(data.focus);
      hubAppearance.keymap = normalizeKeymap(data.keymap);
      hubAppearance.macros = normalizeMacros(data.macros);
      hubAppearance.a11y = normalizeA11y(data.a11y);
      hubAppearance.multiMonitor = data.multiMonitor !== false;
      hubAppearance.cloud = normalizeCloud(data.cloud);
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
        frame.contentWindow.postMessage(payload, frameTargetOrigin(frame));
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
    var a11y = hubAppearance.a11y || normalizeA11y(null);
    document.documentElement.style.setProperty('--ui-scale', String(a11y.fontScale || 1));
    document.body.classList.toggle('hc', !!a11y.highContrast);
    document.body.classList.toggle('reduce-motion', !!a11y.reduceMotion);
    if (a11y.ariaLabels !== false) {
      Array.prototype.forEach.call(document.querySelectorAll('button[title]:not([aria-label])'), function (btn) {
        btn.setAttribute('aria-label', btn.getAttribute('title'));
      });
    } else {
      // 关闭“无障碍标签”时移除之前由 title 复制而来的 aria-label，
      // 否则该开关在本次会话里没有任何可见效果。
      Array.prototype.forEach.call(document.querySelectorAll('button[title][aria-label]'), function (btn) {
        if (btn.getAttribute('aria-label') === btn.getAttribute('title')) {
          btn.removeAttribute('aria-label');
        }
      });
    }
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
    document.body.classList.toggle('no-motion', !hubAppearance.motion || !!a11y.reduceMotion);
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
    var f = hubAppearance.focus || {};
    var fp = document.getElementById('hub-focus-pomodoro');
    if (fp) fp.value = String(f.pomodoro);
    var fb = document.getElementById('hub-focus-break');
    if (fb) fb.value = String(f.breakMin);
    var fs = document.getElementById('hub-focus-sound');
    if (fs) fs.value = f.sound || 'none';
    var fd = document.getElementById('hub-focus-dim');
    if (fd) fd.setAttribute('aria-checked', String(f.dim !== false));
    var fn = document.getElementById('hub-focus-dnd');
    if (fn) fn.setAttribute('aria-checked', String(f.dnd !== false));
    var zenBtn = document.getElementById('zen-btn');
    if (zenBtn) zenBtn.classList.toggle('active', zenActive);
    var multi = document.getElementById('hub-multimonitor');
    if (multi) multi.setAttribute('aria-checked', String(hubAppearance.multiMonitor !== false));
    var cloud = hubAppearance.cloud || normalizeCloud(null);
    var cloudEnabled = document.getElementById('hub-cloud-enabled');
    if (cloudEnabled) cloudEnabled.setAttribute('aria-checked', String(cloud.enabled));
    ['hub-cloud-url', 'hub-cloud-user', 'hub-cloud-password'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = cloud[id.replace('hub-cloud-', '')] || '';
    });
    var cloudSchedule = document.getElementById('hub-cloud-schedule');
    if (cloudSchedule) cloudSchedule.value = cloud.schedule || 'manual';
    var fontSelect = document.getElementById('hub-a11y-font');
    if (fontSelect) fontSelect.value = String(a11y.fontScale);
    [['hub-a11y-contrast', a11y.highContrast], ['hub-a11y-motion', a11y.reduceMotion],
     ['hub-a11y-aria', a11y.ariaLabels]].forEach(function (pair) {
      var node = document.getElementById(pair[0]);
      if (node) node.setAttribute('aria-checked', String(pair[1]));
    });
    broadcastTheme(effectiveTheme());
  }

  function cloudConfigFromForm() {
    var value = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    return {
      enabled: hubAppearance.cloud.enabled,
      url: value('hub-cloud-url'),
      user: value('hub-cloud-user'),
      password: (function () {
        var el = document.getElementById('hub-cloud-password');
        return el && el.value ? el.value : (hubAppearance.cloud.password || '');
      })(),
      schedule: value('hub-cloud-schedule') || 'manual',
      lastAt: hubAppearance.cloud.lastAt || 0,
    };
  }

  function persistCloudConfig() {
    hubAppearance.cloud = cloudConfigFromForm();
    saveHubAppearance();
  }

  function uploadCloudBackup(silent) {
    var cfg = cloudConfigFromForm();
    if (!cfg.url) { if (!silent) toast('请先填写 WebDAV 地址', 'error'); return Promise.resolve(false); }
    var hint = document.getElementById('hub-cloud-hint');
    if (!silent && hint) hint.textContent = '正在生成全量备份并上传…';
    return fetch('/api/cloud/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: cfg.url, user: cfg.user, password: cfg.password }),
    })
      .then(function (r) { return r.json().then(function (d) {
        if (!r.ok || !d.ok) throw new Error((d && d.error) || '上传失败'); return d;
      }); })
      .then(function (d) {
        hubAppearance.cloud = cfg;
        hubAppearance.cloud.lastAt = Date.now();
        saveHubAppearance();
        if (!silent) {
          if (hint) hint.textContent = '上次上传：' + new Date().toLocaleString() +
            ' · ' + ((d.stats || {}).files || 0) + ' 项。';
          toast('云备份已上传');
        }
        return true;
      })
      .catch(function (error) {
        if (!silent) {
          toast('云备份上传失败：' + (error && error.message ? error.message : error), 'error');
          if (hint) hint.textContent = '上传失败，请检查 WebDAV 地址与凭据。';
        }
        return false;
      });
  }

  function downloadCloudRestore() {
    var cfg = cloudConfigFromForm();
    if (!cfg.url) { toast('请先填写 WebDAV 地址', 'error'); return; }
    ommConfirm('从 WebDAV 下载最近的备份并恢复？同名文件会被覆盖，恢复前自动备份当前配置。',
      { title: '从云备份恢复', ok: '下载并恢复', danger: true }).then(function (ok) {
      if (!ok) return;
      fetch('/api/cloud/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cfg.url, user: cfg.user, password: cfg.password }),
      })
        .then(function (r) { return r.json().then(function (d) {
          if (!r.ok || !d.ok) throw new Error((d && d.error) || '下载失败'); return d;
        }); })
        .then(function (d) {
          return fetch('/api/full-restore', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ zip: d.zip }),
          });
        })
        .then(function (r) {
          if (!r.ok) throw new Error('恢复失败（' + r.status + '）');
          return r.json();
        })
        .then(function (result) {
          if (!result.ok) throw new Error(result.error || '恢复失败');
          toast('云备份已恢复，正在重新加载…');
          setTimeout(function () { location.reload(); }, 1000);
        })
        .catch(function (error) {
          toast('云恢复失败：' + (error && error.message ? error.message : error), 'error');
        });
    });
  }

  function cloudAutoTick() {
    var cloud = hubAppearance.cloud || {};
    if (!cloud.enabled || cloud.schedule === 'manual' || !cloud.url) return;
    var interval = cloud.schedule === 'daily' ? 86400000 : 604800000;
    if (Date.now() - (cloud.lastAt || 0) < interval) return;
    toast('正在自动上传到 WebDAV…');
    uploadCloudBackup(true);
  }

  var macroKeyCombo = '';
  var comboCapturing = false;

  function captureCombo(node, done) {
    if (!node || node.dataset.capturing === '1') return;
    comboCapturing = true;
    node.dataset.capturing = '1';
    node.classList.add('capturing');
    var previous = node.textContent;
    node.textContent = '按下组合键…';
    function onKey(event) {
      event.preventDefault();
      event.stopPropagation();
      node.removeEventListener('keydown', onKey, true);
      delete node.dataset.capturing;
      node.classList.remove('capturing');
      comboCapturing = false;
      if (event.key === 'Escape') { node.textContent = previous; return; }
      var combo = comboFromEvent(event);
      if (!combo) { node.textContent = previous; return; }
      node.textContent = combo;
      done(combo);
    }
    node.addEventListener('keydown', onKey, true);
  }

  function renderKeymap() {
    var list = document.getElementById('hub-keymap-list');
    if (!list) return;
    var map = hubAppearance.keymap || {};
    list.innerHTML = COMMANDS.map(function (cmd) {
      return '<div class="keymap-row"><span>' + esc(cmd.label) + '</span>' +
        '<button class="keymap-key" type="button" data-km="' + esc(cmd.id) + '">' +
        esc(map[cmd.id] || cmd.def) + '</button></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-km]'), function (btn) {
      btn.addEventListener('click', function () {
        captureCombo(btn, function (combo) {
          hubAppearance.keymap[btn.dataset.km] = combo;
          saveHubAppearance();
        });
      });
    });
  }

  function renderMacros() {
    var list = document.getElementById('hub-macro-list');
    if (!list) return;
    var macros = hubAppearance.macros || [];
    if (!macros.length) {
      list.innerHTML = '<span class="storage-dim">还没有命令宏。</span>';
      return;
    }
    list.innerHTML = macros.map(function (m, index) {
      return '<div class="macro-row"><b>' + esc(m.name) + '</b>' +
        '<code>' + esc((m.actions || []).join(' → ') || '（无动作）') + '</code>' +
        '<button class="macro-key" type="button" data-macro-key="' + index + '">' +
        esc(m.key || '未绑定') + '</button>' +
        '<button type="button" data-macro-del="' + index + '">删除</button></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-macro-key]'), function (btn) {
      btn.addEventListener('click', function () {
        captureCombo(btn, function (combo) {
          hubAppearance.macros[Number(btn.dataset.macroKey)].key = combo;
          saveHubAppearance();
        });
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('[data-macro-del]'), function (btn) {
      btn.addEventListener('click', function () {
        hubAppearance.macros.splice(Number(btn.dataset.macroDel), 1);
        saveHubAppearance();
        renderMacros();
      });
    });
  }

  function loadAIConfig() {
    var hint = document.getElementById('hub-ai-hint');
    if (!window.OMMDesktop || !window.OMMDesktop.aiConfig) {
      if (hint) hint.textContent = 'AI 配置仅在桌面版可用（浏览器预览模式不连接本机服务）。';
      return;
    }
    aiConfigPromise = window.OMMDesktop.aiConfig().then(function (data) {
      var ai = (data && data.ai) || {};
      aiSavedKey = ai.apiKey || '';
      var set = function (id, value) { var el = document.getElementById(id); if (el) el.value = value || ''; };
      set('hub-ai-provider', ai.provider || 'deepseek');
      set('hub-ai-base', ai.apiBase);
      set('hub-ai-model', ai.apiModel);
      set('hub-ai-system', ai.system);
      set('hub-ai-key', '');
      if (hint) hint.textContent = data.configured
        ? '已保存密钥（为安全起见不再显示）。修改后留空即保持原密钥；需要更换请直接填写新值。'
        : '尚未填写 API Key。在这里填写一次，所有支持 AI 的产品都能读取。';
    }).catch(function () {
      if (hint) hint.textContent = '读取 AI 配置失败；工作台可能未运行在桌面版环境。';
    });
  }

  function saveAIConfig(clearKey) {
    var run = function () {
      var hint = document.getElementById('hub-ai-hint');
      var value = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
      var ai = {
        provider: value('hub-ai-provider') || 'deepseek',
        apiBase: value('hub-ai-base'),
        apiModel: value('hub-ai-model'),
        system: value('hub-ai-system'),
        apiKey: clearKey ? '' : (value('hub-ai-key') || aiSavedKey),
      };
      if (!window.OMMDesktop || !window.OMMDesktop.setAIConfig) {
        toast('AI 配置仅在桌面版可用', 'error');
        return;
      }
      return window.OMMDesktop.setAIConfig(ai).then(function () {
        aiSavedKey = ai.apiKey;
        var key = document.getElementById('hub-ai-key');
        if (key) key.value = '';
        if (hint) hint.textContent = ai.apiKey
          ? 'AI 配置已保存，所有产品下次启动时生效。'
          : 'AI 配置已保存（未设置密钥，在线功能需各产品自行填写）。';
        toast('AI 配置已保存');
      }).catch(function (error) {
        toast('保存 AI 配置失败：' + (error && error.message ? error.message : error), 'error');
      });
    };
    // aiSavedKey 由异步请求填充；若用户抢在加载完成前保存，留空的输入框会被当成
    // “清空密钥”。等加载结束再写，避免静默抹掉服务端已有的密钥。
    return aiConfigPromise ? aiConfigPromise.then(run) : run();
  }

  function openHubSettings() {
    closePopovers();
    closePluginPanel();
    closeCommandPalette();
    closeGlobalSearch();
    closeTimeline();
    els.hubSettings.hidden = false;
    applyHubAppearance();
    loadAIConfig();
    renderKeymap();
    renderMacros();
    loadStorage(false);
    renderUsage();
  }

  function closeHubSettings() {
    els.hubSettings.hidden = true;
    comboCapturing = false;
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
    var settingsClose = document.getElementById('hub-settings-close');
    if (settingsClose) settingsClose.addEventListener('click', closeHubSettings);
    var settingsDone = document.getElementById('hub-settings-done');
    if (settingsDone) settingsDone.addEventListener('click', closeHubSettings);
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
        toast(hubAppearance.snap
          ? snapIntervalLabel(hubAppearance.snap) + '为当前产品自动快照'
          : '已关闭定时快照');
      });
    }
    var focusFields = [
      ['hub-focus-pomodoro', 'pomodoro', Number],
      ['hub-focus-break', 'breakMin', Number],
      ['hub-focus-sound', 'sound', String],
    ];
    focusFields.forEach(function (field) {
      var node = document.getElementById(field[0]);
      if (!node) return;
      node.addEventListener('change', function () {
        hubAppearance.focus[field[1]] = field[2] === Number ? Number(node.value) : node.value;
        if (field[1] === 'sound' && zenActive) setZenSound(node.value);
        saveHubAppearance();
        applyHubAppearance();
      });
    });
    var focusDim = document.getElementById('hub-focus-dim');
    if (focusDim) focusDim.addEventListener('click', function () {
      hubAppearance.focus.dim = !hubAppearance.focus.dim;
      saveHubAppearance();
      applyHubAppearance();
      document.body.classList.toggle('zen-dim', zenActive && hubAppearance.focus.dim);
    });
    var focusDnd = document.getElementById('hub-focus-dnd');
    if (focusDnd) focusDnd.addEventListener('click', function () {
      hubAppearance.focus.dnd = !hubAppearance.focus.dnd;
      saveHubAppearance();
      applyHubAppearance();
      document.body.classList.toggle('zen-dnd', zenActive && hubAppearance.focus.dnd);
    });
    var aiProvider = document.getElementById('hub-ai-provider');
    var aiPresets = {
      deepseek: ['https://api.deepseek.com', 'deepseek-flash'],
      openai: ['https://api.openai.com/v1', 'gpt-4o-mini'],
      openrouter: ['https://openrouter.ai/api/v1', 'deepseek/deepseek-chat'],
      zhipu: ['https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash'],
      custom: ['', ''],
    };
    if (aiProvider) aiProvider.addEventListener('change', function () {
      var preset = aiPresets[aiProvider.value];
      if (!preset) return;
      var base = document.getElementById('hub-ai-base');
      var model = document.getElementById('hub-ai-model');
      if (base && !base.value.trim()) base.value = preset[0];
      if (model && !model.value.trim()) model.value = preset[1];
    });
    var aiSave = document.getElementById('hub-ai-save');
    if (aiSave) aiSave.addEventListener('click', function () { saveAIConfig(false); });
    var aiLoad = document.getElementById('hub-ai-load');
    if (aiLoad) aiLoad.addEventListener('click', loadAIConfig);
    var aiClear = document.getElementById('hub-ai-clear');
    if (aiClear) aiClear.addEventListener('click', function () {
      ommConfirm('清除本机保存的 AI 密钥？各产品自己的密钥不受影响。',
        { title: '清除 AI 密钥', ok: '清除', danger: true }).then(function (ok) {
        if (ok) saveAIConfig(true);
      });
    });
    var a11yFont = document.getElementById('hub-a11y-font');
    if (a11yFont) a11yFont.addEventListener('change', function () {
      hubAppearance.a11y.fontScale = Number(a11yFont.value) || 1;
      saveHubAppearance();
      applyHubAppearance();
    });
    [['hub-a11y-contrast', 'highContrast'], ['hub-a11y-motion', 'reduceMotion'],
     ['hub-a11y-aria', 'ariaLabels']].forEach(function (pair) {
      var node = document.getElementById(pair[0]);
      if (!node) return;
      node.addEventListener('click', function () {
        hubAppearance.a11y[pair[1]] = !hubAppearance.a11y[pair[1]];
        saveHubAppearance();
        applyHubAppearance();
      });
    });
    var cloudEnabled = document.getElementById('hub-cloud-enabled');
    if (cloudEnabled) cloudEnabled.addEventListener('click', function () {
      hubAppearance.cloud.enabled = !hubAppearance.cloud.enabled;
      saveHubAppearance();
      applyHubAppearance();
    });
    var cloudUpload = document.getElementById('hub-cloud-upload');
    if (cloudUpload) cloudUpload.addEventListener('click', function () { persistCloudConfig(); uploadCloudBackup(false); });
    var cloudDownload = document.getElementById('hub-cloud-download');
    if (cloudDownload) cloudDownload.addEventListener('click', function () { persistCloudConfig(); downloadCloudRestore(); });
    var cloudClear = document.getElementById('hub-cloud-clear');
    if (cloudClear) cloudClear.addEventListener('click', function () {
      ommConfirm('清除本机保存的 WebDAV 地址与凭据？云端已有备份不会删除。',
        { title: '清除云备份凭据', ok: '清除', danger: true }).then(function (ok) {
        if (!ok) return;
        hubAppearance.cloud = normalizeCloud({ schedule: hubAppearance.cloud.schedule });
        saveHubAppearance();
        applyHubAppearance();
        toast('云备份凭据已清除');
      });
    });
    var multiSwitch = document.getElementById('hub-multimonitor');
    if (multiSwitch) multiSwitch.addEventListener('click', function () {
      hubAppearance.multiMonitor = hubAppearance.multiMonitor === false;
      saveHubAppearance();
      applyHubAppearance();
    });
    var keymapReset = document.getElementById('hub-keymap-reset');
    if (keymapReset) keymapReset.addEventListener('click', function () {
      ommConfirm('把所有快捷键恢复为默认组合？命令宏不受影响。',
        { title: '恢复默认快捷键', ok: '恢复' }).then(function (ok) {
        if (!ok) return;
        hubAppearance.keymap = normalizeKeymap(null);
        saveHubAppearance();
        renderKeymap();
        toast('快捷键已恢复默认');
      });
    });
    var macroName = document.getElementById('hub-macro-name');
    var macroActions = document.getElementById('hub-macro-actions');
    var macroKey = document.getElementById('hub-macro-key');
    if (macroKey) macroKey.addEventListener('click', function () {
      captureCombo(macroKey, function (combo) { macroKeyCombo = combo; });
    });
    var macroAdd = document.getElementById('hub-macro-add');
    if (macroAdd) macroAdd.addEventListener('click', function () {
      var name = macroName && macroName.value.trim();
      var actions = macroActions && macroActions.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!name || !actions || !actions.length) {
        toast('请填写宏名称和至少一个动作', 'error');
        return;
      }
      hubAppearance.macros = normalizeMacros((hubAppearance.macros || []).concat([
        { name: name, actions: actions, key: macroKeyCombo }
      ]));
      saveHubAppearance();
      macroKeyCombo = '';
      if (macroName) macroName.value = '';
      if (macroActions) macroActions.value = '';
      if (macroKey) macroKey.textContent = '点击后按组合键';
      renderMacros();
      toast('命令宏已添加');
    });
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
    var fullBackup = document.getElementById('hub-full-backup');
    if (fullBackup) fullBackup.addEventListener('click', downloadFullBackup);
    var fullRestorePick = document.getElementById('hub-full-restore-pick');
    var fullRestoreFile = document.getElementById('hub-full-restore-file');
    if (fullRestorePick && fullRestoreFile) {
      fullRestorePick.addEventListener('click', function () { fullRestoreFile.click(); });
      fullRestoreFile.addEventListener('change', function () {
        var file = fullRestoreFile.files && fullRestoreFile.files[0];
        fullRestoreFile.value = '';
        if (file) restoreFullBackup(file);
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
    var settingsReset = document.getElementById('hub-settings-reset');
    if (settingsReset) settingsReset.addEventListener('click', function () {
      // 统一走归一化函数补全全部字段；手写对象曾遗漏 focus/cloud/a11y 等，
      // 导致重置后静心模式、云备份、无障碍开关在刷新前一直抛 TypeError。
      hubAppearance = normalizeAppearance(null);
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
      snap: SNAP_INTERVALS.indexOf(Number(data.snap)) >= 0 ? Number(data.snap) : 0,
      dockSort: data.dockSort === 'usage' ? 'usage' : 'fixed',
      focus: normalizeFocus(data.focus),
      keymap: normalizeKeymap(data.keymap),
      macros: normalizeMacros(data.macros),
      a11y: normalizeA11y(data.a11y),
      multiMonitor: data.multiMonitor !== false,
      cloud: normalizeCloud(data.cloud),
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
        toast('不是静书房设置备份', 'error');
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
              // 与 loadLauncherPrefs 保持一致：只接受字符串 id，避免备份里的
              // 数字 / 对象破坏后续的 indexOf 与 dataset 写入。
              if (Array.isArray(data.launcher.pinned)) {
                launcherPinned = data.launcher.pinned.filter(function (id) { return typeof id === 'string'; }).slice(0, 8);
              }
              if (Array.isArray(data.launcher.recent)) {
                launcherRecent = data.launcher.recent.filter(function (id) { return typeof id === 'string'; }).slice(0, 8);
              }
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

  function base64FromBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function downloadFullBackup() {
    var hint = document.getElementById('hub-full-backup-hint');
    if (hint) hint.textContent = '正在打包全量备份（文件较多时可能需要几十秒）…';
    fetch('/api/full-backup', { cache: 'no-store' })
      .then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok || !result.ok) throw new Error((result && result.error) || '备份失败');
          return result;
        });
      })
      .then(function (result) {
        var binary;
        try {
          binary = atob(result.zip || '');
        } catch (e) {
          throw new Error('备份文件已损坏，无法解码');
        }
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var blob = new Blob([bytes], { type: 'application/zip' });
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'jing-shufang-full-' + backupStamp() + '.zip';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        var s = result.stats || {};
        toast('全量备份已生成：' + (s.files || 0) + ' 项（含快照 ' +
          (s.snapshots || 0) + '、共享 ' + (s.share || 0) + '）');
        if (hint) hint.textContent = '全量备份包含所有产品的设置、共享空间、快照与已保存文档，可整体迁移到新电脑。';
      })
      .catch(function (error) {
        toast('全量备份失败：' + (error && error.message ? error.message : error), 'error');
        if (hint) hint.textContent = '全量备份失败，请重试或查看通知。';
      });
  }

  function restoreFullBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      ommConfirm(
        '这会从全量备份恢复设置、共享空间、快照与所有已保存文档。\n' +
        '同名文件将被覆盖，未包含在备份中的文件会保留；恢复前会自动备份当前配置。继续？',
        { title: '从全量备份恢复', ok: '恢复', danger: true }
      ).then(function (ok) {
        if (!ok) return;
        var payload = JSON.stringify({ zip: base64FromBuffer(reader.result) });
        fetch('/api/full-restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        })
          .then(function (response) {
            return response.json().then(function (result) {
              if (!response.ok || !result.ok) throw new Error((result && result.error) || '恢复失败');
              return result;
            });
          })
          .then(function (result) {
            var r = result.restored || {};
            toast('全量恢复完成，正在重新加载…（' +
              (r.files || 0) + ' 文档 / ' + (r.snapshots || 0) + ' 快照）');
            setTimeout(function () { location.reload(); }, 1000);
          })
          .catch(function (error) {
            toast('恢复失败：' + (error && error.message ? error.message : error), 'error');
          });
      });
    };
    reader.onerror = function () { toast('读取备份文件失败', 'error'); };
    reader.readAsArrayBuffer(file);
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
    closeGlobalSearch();
    closeTimeline();
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
      '<button class="pp-btn" type="button" data-pp-action="detail" data-id="' +
      esc(app.id) + '" title="查看详情与权限">详情</button>' +
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

  function showPluginDetail(pluginId) {
    var app = (PLUGIN_INFO || []).filter(function (item) { return item.id === pluginId; })[0];
    if (!app || !els.ppBody) return;
    var channels = ((app.share && app.share.channels) || []);
    var roles = { publish: '仅发布', consume: '仅接收', both: '发布与接收' };
    var channelHtml = channels.length
      ? '<div class="pp-detail-channels">' + channels.map(function (c) {
          return '<div class="pp-channel"><code>' + esc(c.id) + '</code>' +
            '<span>' + esc(roles[c.role] || c.role || 'both') + '</span>' +
            (c.name ? '<span>' + esc(c.name) + '</span>' : '') + '</div>';
        }).join('') + '</div>'
      : '<div class="setting-hint">该插件没有声明共享频道，不会读写其他产品的数据。</div>';
    els.ppBody.innerHTML =
      '<div class="pp-detail">' +
      '<div class="setting-actions"><button class="pp-btn" type="button" data-pp-action="detail-back">← 返回列表</button></div>' +
      '<h2 class="pp-detail-title">' + esc(app.name) + ' <small>' + esc(app.version || '') + '</small></h2>' +
      '<p class="pp-note">' + esc(app.description || '暂无说明') + '</p>' +
      '<dl class="pp-detail-list">' +
      '<div><dt>标识</dt><dd><code>' + esc(app.id) + '</code></dd></div>' +
      '<div><dt>来源</dt><dd>' + (app.source === 'user' ? '用户安装' : '内置') + '</dd></div>' +
      '<div><dt>运行时</dt><dd>' + esc(app.runtime || 'static') + '</dd></div>' +
      '<div><dt>端口</dt><dd>' + esc(app.port || '—') + '</dd></div>' +
      '<div><dt>作者</dt><dd>' + esc(app.author || '—') + '</dd></div>' +
      '<div><dt>主页</dt><dd>' + (app.homepage
        ? '<a href="' + esc(app.homepage) + '" target="_blank" rel="noreferrer">' + esc(app.homepage) + '</a>'
        : '—') + '</dd></div>' +
      '</dl>' +
      '<h3 class="pp-detail-h3">共享权限声明</h3>' + channelHtml +
      '<p class="setting-hint">声明只代表插件申请的能力；实际连接规则由“存档 → 跨产品共享”决定，随时可以撤销。</p>' +
      '<div class="setting-actions">' +
      '<button class="pp-btn primary" type="button" data-pp-action="open" data-id="' + esc(app.id) + '">打开插件</button>' +
      (app.rollback
        ? '<button class="pp-btn" type="button" data-pp-action="rollback" data-id="' + esc(app.id) + '">回滚到上一版本</button>'
        : '') +
      '</div></div>';
  }

  function rollbackPlugin(pluginId) {
    ommConfirm('把这个插件恢复到更新前的版本？当前版本会被替换（不会删除你的文档与设置）。',
      { title: '回滚插件', ok: '回滚', danger: true }).then(function (ok) {
      if (!ok) return;
      fetch('/api/plugins/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pluginId }),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok || !data.ok) throw new Error((data && data.error) || '回滚失败');
            return data;
          });
        })
        .then(function () {
          toast('已回滚，正在重新加载…');
          setTimeout(function () { location.reload(); }, 800);
        })
        .catch(function (error) {
          toast('回滚失败：' + (error && error.message ? error.message : error), 'error');
        });
    });
  }

  function renderInstalledPlugins() {
    if (!APP_LIST.length) {
      els.ppBody.innerHTML =
        '<div class="pp-empty">还没有安装插件。<br>切换到“在线插件”选择产品，或“导入插件”安装自己的页面。</div>';
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
    // 与后端 plugin_specs.is_newer 的 Python 元组比较保持一致：
    // 不补零，逐位比较，全部相等时位数更多的更大（(1,2,0) > (1,2)）。
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return a.length > b.length;
  }

  /* 是否有框架更新：按钮渲染与实际操作必须共用这一判断，避免出现
     “显示立即更新，点击却说没有可用更新”的矛盾。后端给出 available 时
     以后端为准；旧后端没有该字段时回退到本地版本比较。 */
  function frameworkUpdateAvailable(info) {
    if (!info || info.error) return false;
    if (typeof info.available === 'boolean') return info.available;
    return isNewerVersion(info.latest || '', info.current || '');
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
    if (!frameworkUpdateAvailable(info)) {
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
        if (!response.ok) throw new Error('检查更新失败（' + response.status + '）');
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
    if (!frameworkUpdateAvailable(updateInfo)) {
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
        if (!response.ok) throw new Error('更新请求失败（' + response.status + '）');
        return response.json();
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || '更新失败');
        toast('更新完成，工作台即将重启…');
        // 后台进程会自行重启，但页面不会自动刷新；主动重载才能看到新版本。
        window.setTimeout(function () { window.location.reload(); }, 1500);
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
        /* Compare numerically against the locally installed version so a
           built-in build newer than the catalog is never offered as an
           "update" (which would really be a downgrade). */
        var canUpdate = installed && isNewerVersion(item.version, item.installed_version);
        var label = busy ? '处理中…' : canUpdate ? '更新' : installed ? '重新安装' : '安装';
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
      '<p class="pp-note">在线插件来自静书房官方发布，下载后安装到本地，之后离线可用。</p>' +
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
          '<p class="pp-note">把页面打包成 zip，即可在“导入插件”中安装；完整字段说明如下。</p>' +
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
    ommConfirm('卸载“' + app.name + '”？本地数据会保留。',
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
        toast('已导入“' + (data.plugin ? data.plugin.name : file.name) + '”');
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

  function toast(message, kind) {
    els.toast.textContent = message;
    // 多处调用会传 'error'，之前被静默丢弃，导致失败提示与成功提示无法区分。
    els.toast.classList.toggle('error', kind === 'error');
    els.toast.classList.add('on');
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(function () {
      els.toast.classList.remove('on');
      els.toast.classList.remove('error');
    }, 1600);
  }

  function closePopovers() {
    launcherOpen = false;
    if (els.launcher) els.launcher.hidden = true;
    if (els.layoutMenu) els.layoutMenu.hidden = true;
    if (els.ctxMenu) els.ctxMenu.hidden = true;
    if (els.notifyPanel) els.notifyPanel.hidden = true;
    if (graphOpen) closeKnowledgeGraph();
    if (flowOpen) closeDataFlow();
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
        frame.contentWindow.postMessage({ type: 'omm:share-nudge' }, frameTargetOrigin(frame));
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
      // 必须等 iframe 真正载入了产品页（dataset.ready），否则 contentWindow
      // 仍指向 about:blank，消息会在导航中丢失，用户却被告知“已交给…载入”。
      if (frame && frame.dataset.ready === '1' && frame.contentWindow) {
        window.clearInterval(timer);
        try {
          frame.contentWindow.postMessage(
            {
              type: 'omm:load-file',
              path: detail.path,
              name: detail.name,
              mime: detail.mime,
            },
            frameTargetOrigin(frame)
          );
          toast('已交给“' + APP_BY_ID[appId].name + '”载入');
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
        '<div class="loading-box"><span class="spinner"></span><span>正在启动“' +
        esc(app.name) +
        '”…</span></div>'
      );
    }
    if (status === 'sleeping') {
      return (
        '<div class="loading-box"><span class="sleep-glyph">◌</span><span>“' +
        esc(app.name) +
        '”已休眠，内存已释放</span>' +
        '<button class="retry-btn" type="button" data-act="wake" data-app="' +
        esc(app.id) +
        '">唤醒</button></div>'
      );
    }
    if (status === 'error') {
      return (
        '<div class="error-box"><strong>无法启动“' +
        esc(app.name) +
        '”</strong><span>' +
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
        // 首次载入也要发完整的强调色 / 圆角配置，否则各产品的归档面板
        // 只能拿到 theme，用户的自定义外观要等到下次手动切换主题才生效。
        frame.contentWindow.postMessage(
          Object.assign({ type: 'omm:theme' }, accentBroadcastPayload(effectiveTheme())),
          frameTargetOrigin(frame)
        );
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
        /* Size the frame before navigation so the page's first layout reads the
           real viewport width; otherwise it boots in the ≤720px mobile layout. */
        sizeFrameBeforeLoad(frame, appId);
        frame.dataset.url = url;
        // 把工作台的真实 origin 交给产品，便于它把回执 postMessage 发给明确的
        // 目标 origin（跨 origin 下无法从 window.parent.location 读取）。
        frame.src = url + join + 'omm_embed=1&omm_hub_origin=' +
          encodeURIComponent(window.location.origin);
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

  /* Give a freshly created iframe its final pane geometry *before* navigating
     to the real URL.  syncFrames only sizes frames once appStatus === 'ready'
     (i.e. after load), which left the first paint happening at the browser's
     default ~300px viewport.  Width-sensitive pages (e.g. planner) then painted
     the mobile layout — the "更多" affordance — and kept it until a view switch
     forced a re-render.  Sizing up front makes the first layout see the real
     innerWidth. */
  function sizeFrameBeforeLoad(frame, appId) {
    var paneId = findPaneByApp(appId);
    if (!paneId) return;
    var rect = computeRects().panes.get(paneId);
    if (!rect) return;
    frame.style.left = rect.x + 1 + 'px';
    frame.style.top = rect.y + HEAD + 1 + 'px';
    frame.style.width = Math.max(0, rect.w - 2) + 'px';
    frame.style.height = Math.max(0, rect.h - HEAD - 2) + 'px';
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
        toast('已重新打开“' + APP_BY_ID[appId].name + '”');
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
    toast('已休眠“' + APP_BY_ID[appId].name + '”，点击标签可唤醒');
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
    toast('这个内容不能拖放，请使用行内的“发送”按钮', 'error');
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

  /* ---- Cmd+K 检索增强：纯函数，便于单独测试；面板本体不改写 ---- */
  function cmdkPad(n) {
    return n < 10 ? '0' + n : String(n)
  }

  function cmdkFormatNumber(value) {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6)
  }

  /* 子序列模糊评分：连续命中与词首命中加权，完全不匹配返回 -1。 */
  function cmdkFuzzyScore(text, query) {
    var s = String(text == null ? '' : text).toLowerCase()
    var q = String(query == null ? '' : query).trim().toLowerCase()
    if (!q) return 0
    var exact = s.indexOf(q)
    if (exact >= 0) return 1000 - exact + (exact === 0 ? 200 : 0)
    var qi = 0
    var score = 0
    var streak = 0
    var last = -1
    for (var i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) {
        streak = last === i - 1 ? streak + 1 : 0
        score += 10 + streak * 8 + (i === 0 ? 15 : 0)
        last = i
        qi++
      }
    }
    return qi === q.length ? score : -1
  }

  /* 匹配分 + 使用频率加权；稳定排序保留原始顺序作为同分兜底。 */
  function cmdkRank(items, query, usage) {
    var q = String(query == null ? '' : query).trim().toLowerCase()
    if (!q) return (items || []).slice()
    var usageMap = usage || {}
    return (items || []).map(function (item, idx) {
      var text = [item.label, item.hint, item.group, item.keywords].join(' ')
      var score = cmdkFuzzyScore(text, q)
      if (score < 0) return null
      var u = item.appId && usageMap[item.appId]
      var boost = u
        ? Math.min(60, ((u.opens || 0) * 2 + Math.round((u.seconds || 0) / 60)) * 3)
        : 0
      return { item: item, score: score + boost, idx: idx }
    }).filter(Boolean).sort(function (a, b) {
      return b.score - a.score || a.idx - b.idx
    }).map(function (hit) {
      return hit.item
    })
  }

  function cmdkCopy(text, message) {
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(text);
    } catch (e) {
      /* clipboard is optional */
    }
    toast(message)
  }

  /* 即时命令：本地计算 / 日期 / 进制换算，不触发网络。 */
  function cmdkInstantItems(query) {
    var q = String(query == null ? '' : query).trim()
    if (!q) return []
    var out = []
    var m = /^=\s*(.+)$/.exec(q)
    if (m) {
      var expr = m[1].trim()
      if (/^[\d+\-*/().\s%]+$/.test(expr)) {
        try {
          var value = Function('"use strict"; return (' + expr + ')')()
          if (typeof value === 'number' && isFinite(value)) {
            out.push({
              group: '即时命令', label: '= ' + cmdkFormatNumber(value),
              hint: '计算 ' + expr, glyph: '算',
              run: (function (v) {
                return function () { cmdkCopy(String(v), '已复制计算结果') }
              })(value),
            })
          }
        } catch (e) {
          /* invalid expression: no instant item */
        }
      }
    }
    if (/^@date$/i.test(q)) {
      var d = new Date()
      var label = d.getFullYear() + '-' + cmdkPad(d.getMonth() + 1) + '-' + cmdkPad(d.getDate())
      var ts = String(d.getTime())
      out.push({
        group: '即时命令', label: label,
        hint: '今天 · Unix 时间戳 ' + ts, glyph: '日',
        run: function () { cmdkCopy(ts, '已复制时间戳') },
      })
    }
    var radix = /^(hex|bin|oct)\s+(\d+)$/i.exec(q)
    if (radix) {
      var n = parseInt(radix[2], 10)
      if (isFinite(n) && n >= 0) {
        var kind = radix[1].toLowerCase()
        var converted = kind === 'hex' ? '0x' + n.toString(16)
          : kind === 'bin' ? '0b' + n.toString(2)
            : '0o' + n.toString(8)
        out.push({
          group: '即时命令', label: converted,
          hint: radix[2] + ' 的' + (kind === 'hex' ? '十六进制' : kind === 'bin' ? '二进制' : '八进制'),
          glyph: '进',
          run: (function (v) {
            return function () { cmdkCopy(v, '已复制换算结果') }
          })(converted),
        })
      }
    }
    return out
  }

  function cmdkActionList() {
    var list = [
      { label: '最近动态', hint: '跨产品的文档、快照、共享与通知', keywords: 'timeline recent zuijin dongtai', run: function () { openTimeline(); } },
      { label: '开启 / 退出静心专注', hint: '番茄钟 + 环境音　Ctrl+Shift+Z', keywords: 'focus zen jingxin zhuanzhu', run: function () { setZen(!zenActive); } },
      { label: '全局内容搜索', hint: '跨产品全文检索　Ctrl+Shift+F', keywords: 'search sousuo quanju wenben', run: function () { openGlobalSearch(); } },
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
    (hubAppearance.macros || []).forEach(function (macro, index) {
      list.push({
        group: '命令宏',
        label: '宏：' + macro.name,
        hint: (macro.key || '未绑定') + ' · ' + (macro.actions || []).join(' → '),
        keywords: 'macro hong ' + macro.name,
        run: function () { runMacro(index); },
      });
    });
    return list;
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
        appId: app.id,
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
        appId: appId,
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
    // 知识卡片 / 笔记 / 搜索历史：直接读取各产品既有的 localStorage，不另建存储，
    // 动作也复用既有的 openKnowledgeGraph / showKgDetail / activateApp。
    function cmdkRead(key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    }
    var cmdkCards = [];
    ['zen.cards.v1', 'zen.inbox.v1', 'zen.clip.v1'].forEach(function (key) {
      (cmdkRead(key, []) || []).forEach(function (c) {
        if (c && c.content && !cmdkCards.some(function (x) { return x.id === c.id; })) {
          cmdkCards.push(c);
        }
      });
    });
    cmdkCards.slice(-12).reverse().forEach(function (c) {
      items.push({
        group: '知识卡片',
        label: String(c.content || '').slice(0, 42),
        hint: (c.source || 'manual') + ' · ' + (c.kind || 'note'),
        glyph: '卡',
        keywords: (c.tags || []).join(' ') + ' ' + (c.note || ''),
        run: function () { openKnowledgeGraph(); showKgDetail(c); },
      });
    });
    var cmdkDocs = cmdkRead('zc-docs', null);
    if (cmdkDocs && cmdkDocs.meta) {
      Object.keys(cmdkDocs.meta).slice(0, 12).forEach(function (id) {
        var doc = cmdkDocs.meta[id] || {};
        items.push({
          group: '笔记',
          label: doc.name || id,
          hint: ((doc.nodes || []).length || 0) + ' 个节点',
          glyph: '写',
          keywords: id,
          appId: 'writer',
          run: function () { activateApp('writer'); },
        });
      });
    }
    var cmdkSearch = cmdkRead('omm-search-v1', null);
    ((cmdkSearch && cmdkSearch.history) || []).slice(-10).reverse().forEach(function (h) {
      if (!h || !h.query) return;
      items.push({
        group: '搜索历史',
        label: h.query,
        hint: String(h.answer || '').slice(0, 36),
        glyph: '搜',
        keywords: 'history',
        appId: 'search',
        run: function () { activateApp('search'); },
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
    // 候选集 = 已注册项 + 即时命令；匹配与加权交给纯函数，分组渲染保持不变。
    cmdkFiltered = cmdkRank(cmdkItems.concat(cmdkInstantItems(query)), query, usageStats);
    if (cmdkIndex >= cmdkFiltered.length) cmdkIndex = Math.max(0, cmdkFiltered.length - 1);
    if (cmdkIndex < 0) cmdkIndex = 0;
    if (!cmdkFiltered.length) {
      els.cmdkList.innerHTML = '<div class="cmdk-empty">没有匹配的命令或应用。</div>';
      return;
    }
    var groups = ['即时命令', '应用', '已打开', '动作', '知识卡片', '笔记', '搜索历史', '最近文件', '共享项目'];
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

  /* ---------- 全局内容搜索：跨产品全文检索（基于桌面桥 /__omm/fs/search） ---------- */
  function openGlobalSearch(initial) {
    if (!els.gsearch) return;
    closePopovers();
    closeCommandPalette();
    closePluginPanel();
    closeTimeline();
    if (els.hubSettings) els.hubSettings.hidden = true;
    gsearchOpen = true;
    els.gsearch.hidden = false;
    els.gsearchInput.value = initial || '';
    gsearchIndex = 0;
    var q = (initial || '').trim();
    if (q) runGlobalSearch();
    else renderGlobalSearch(null, '输入关键词，检索全部产品中已保存的文档内容。');
    setTimeout(function () { els.gsearchInput.focus(); els.gsearchInput.select(); }, 0);
  }

  function closeGlobalSearch() {
    if (!els.gsearch) return;
    gsearchOpen = false;
    gsearchSeq += 1;
    window.clearTimeout(gsearchTimer);
    els.gsearch.hidden = true;
    els.gsearchInput.value = '';
    gsearchResults = [];
    gsearchIndex = 0;
  }

  /* ---------- 知识图谱：收集各产品的 zen-card 并画出引用 / 标签关系 ---------- */
  function kgLocalCards() {
    var out = [];
    ['zen.cards.v1', 'zen.inbox.v1', 'zen.clip.v1'].forEach(function (key) {
      try {
        var raw = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(raw)) out = out.concat(raw);
      } catch (e) { /* ignore */ }
    });
    return out;
  }

  function kgNormalize(card) {
    if (!card || typeof card !== 'object' || !card.content) return null;
    return {
      id: String(card.id || ('kg-' + Math.random().toString(36).slice(2))),
      kind: String(card.kind || 'note'),
      source: String(card.source || 'manual'),
      content: String(card.content),
      tags: Array.isArray(card.tags) ? card.tags.slice(0, 8).map(String) : [],
      links: Array.isArray(card.links) ? card.links : [],
      color: String(card.color || ''),
      ref: String(card.ref || ''),
    };
  }

  function collectGraphCards() {
    var seq = ++graphSeq;
    graphCards = [];
    kgLocalCards().forEach(function (c) {
      var n = kgNormalize(c);
      if (n) graphCards.push(n);
    });
    graphCards = dedupeGraphCards(graphCards);
    renderKnowledgeGraph();
    /* Ask every embedded product for its own cards; replies are merged below. */
    frames.forEach(function (frame) {
      var origin = frameTargetOrigin(frame);
      if (!origin) return;
      try {
        frame.contentWindow.postMessage(
          { type: 'omm:zen-card-request', token: String(seq) }, origin
        );
      } catch (e) { /* ignore */ }
    });
    window.setTimeout(function () {
      if (seq === graphSeq && graphOpen) renderKnowledgeGraph();
    }, 600);
  }

  /* ---------------------------------------------------------------- live data */
  /* The AI workspace asks the Hub for a read-only snapshot of the user's real
   * product data. The Hub is the only pane that can cross iframe origins: it can
   * read same-origin localStorage (web build) and fan out the existing
   * zen-card-request to every embedded product (desktop, isolated ports). */
  var liveDataWaiters = Object.create(null);
  var liveDataSeq = 0;

  function collectLiveLocalData() {
    function arr(key) {
      try {
        var raw = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(raw) ? raw : [];
      } catch (e) { return []; }
    }
    function text(v, n) { return String(v == null ? '' : v).slice(0, n); }
    return {
      cards: arr('zen.cards.v1').concat(arr('zen.inbox.v1')).slice(0, 200).map(function (c) {
        return { content: text(c.content, 1500), kind: text(c.kind, 40),
          tags: Array.isArray(c.tags) ? c.tags.slice(0, 8).map(String) : [], source: text(c.source, 40) };
      }),
      notes: arr('zc-docs').slice(0, 100).map(function (d) {
        return { title: text(d.title, 200), content: text(d.content != null ? d.content : d.text, 1500) };
      }),
      searches: arr('omm-search-v1').slice(0, 100).map(function (s) {
        return { query: text(s.query, 300), answer: text(s.answer, 1200) };
      }),
      rules: arr('zen.flow.rules.v1').slice(0, 100).map(function (r) {
        return { name: text(r.name, 200), enabled: r.enabled !== false };
      }),
      clips: arr('zen.clip.v1').slice(0, 100).map(function (c) {
        return { content: text(c.content, 1200), source: text(c.source, 40) };
      }),
      // Timeline + Planner are what ZenReview asks for. Same-origin (web build)
      // reads them directly; on isolated desktop ports they degrade to empty and
      // the product falls back to its manual paste boxes.
      timeline: (function () {
        var items = (flowEvents || []).slice(0, 60).map(function (ev) {
          return { app: text(ev.kind, 40), ts: ev.at ? new Date(ev.at).toISOString() : '', title: text(ev.text, 300) };
        });
        // Chart-to-report: Viz products register a review entry in this key.
        arr('zen.viz.review.v1').slice(-40).forEach(function (e) {
          if (e && typeof e === 'object') {
            items.push({ app: 'visualization', ts: text(e.ts, 40),
              title: text(e.title, 300) + ' · ' + text(e.chartType, 40) + ' (' + (e.rows || 0) + ' 行)' });
          }
        });
        return items.slice(0, 80);
      })(),
      planner: (function () {
        var out = [];
        var data = arr('zp-data-v2')[0];
        if (!data || typeof data !== 'object') return out;
        var days = data.days || data.eventsBy || {};
        Object.keys(days).slice(0, 60).forEach(function (day) {
          var list = Array.isArray(days[day]) ? days[day] : (days[day] && days[day].events) || [];
          list.slice(0, 40).forEach(function (e) {
            if (!e || typeof e !== 'object') return;
            out.push({ title: text(e.title, 300), done: e.done === true || e.done === 'failed', day: text(day, 40) });
          });
        });
        return out.slice(0, 100);
      })(),
    };
  }

  function respondLiveData(sourceFrame, origin) {
    var token = 'live' + (++liveDataSeq);
    var snapshot = collectLiveLocalData();
    var waiter = liveDataWaiters[token] = { frame: sourceFrame, origin: origin, snapshot: snapshot };
    frames.forEach(function (frame) {
      var target = frameTargetOrigin(frame);
      if (!target) return;
      try {
        frame.contentWindow.postMessage({ type: 'omm:zen-card-request', token: token }, target);
      } catch (e) { /* ignore */ }
    });
    waiter.timer = window.setTimeout(function () {
      var w = liveDataWaiters[token];
      if (!w) return;
      delete liveDataWaiters[token];
      // de-duplicate cards collected from all panes by content prefix.
      var seen = Object.create(null);
      w.snapshot.cards = (w.snapshot.cards || []).filter(function (c) {
        var key = String(c.content || '').slice(0, 100);
        if (!key || seen[key]) return false;
        seen[key] = 1;
        return true;
      }).slice(0, 200);
      try {
        w.frame.contentWindow.postMessage(
          { type: 'omm:live-data-reply', token: token, data: w.snapshot }, w.origin
        );
      } catch (e) { /* ignore */ }
    }, 700);
  }

  function dedupeGraphCards(list) {
    var seen = Object.create(null);
    return (list || []).filter(function (c) {
      if (!c || seen[c.id]) return false;
      seen[c.id] = 1;
      return true;
    });
  }

  function openKnowledgeGraph() {
    if (!els.knowledgeGraph) return;
    closePopovers();
    closeCommandPalette();
    closePluginPanel();
    closeGlobalSearch();
    closeTimeline();
    if (els.hubSettings) els.hubSettings.hidden = true;
    graphOpen = true;
    els.knowledgeGraph.hidden = false;
    collectGraphCards();
  }

  function closeKnowledgeGraph() {
    graphOpen = false;
    graphSeq += 1;
    if (els.knowledgeGraph) els.knowledgeGraph.hidden = true;
  }

  function renderKnowledgeGraph() {
    if (!els.kgCanvas || !els.kgCanvas.getContext) return;
    var ctx = els.kgCanvas.getContext('2d');
    var W = els.kgCanvas.width, H = els.kgCanvas.height;
    ctx.clearRect(0, 0, W, H);
    var list = graphCards.slice(0, 120);
    if (!list.length) {
      ctx.fillStyle = '#888';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('没有卡片：在任意产品的右下角“卡”按钮剪藏内容后即可看到关系图。', W / 2, H / 2);
      ctx.textAlign = 'left';
      if (els.kgStatus) els.kgStatus.textContent = '暂无卡片';
      if (els.kgList) els.kgList.innerHTML = '';
      return;
    }
    graphPos = list.map(function (c, i) {
      var a = (i / list.length) * Math.PI * 2 - Math.PI / 2;
      return {
        x: W / 2 + Math.cos(a) * (W / 2 - 80),
        y: H / 2 + Math.sin(a) * (H / 2 - 60),
        card: c,
      };
    });
    var edges = [];
    list.forEach(function (c, i) {
      (c.links || []).forEach(function (l) {
        var j = list.findIndex(function (x) { return x.id === l.id; });
        if (j >= 0 && j !== i) edges.push({ a: i, b: j, kind: 'ref' });
      });
    });
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var ta = list[i].tags || [], tb = list[j].tags || [];
        if (ta.some(function (t) { return tb.indexOf(t) >= 0; })) edges.push({ a: i, b: j, kind: 'tag' });
      }
    }
    edges.forEach(function (e) {
      ctx.beginPath();
      ctx.moveTo(graphPos[e.a].x, graphPos[e.a].y);
      ctx.lineTo(graphPos[e.b].x, graphPos[e.b].y);
      ctx.strokeStyle = e.kind === 'ref' ? 'rgba(91,118,146,0.45)' : 'rgba(124,127,66,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    graphPos.forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = p.card.color || '#b56545';
      ctx.fill();
      ctx.strokeStyle = '#26231f';
      ctx.stroke();
    });
    if (els.kgStatus) {
      els.kgStatus.textContent = graphCards.length + ' 张卡片 · ' + edges.length + ' 条关系（引用 / 同标签）';
    }
    if (els.kgList) {
      els.kgList.innerHTML = list.map(function (c, i) {
        return '<div class="kg-item" data-i="' + i + '" title="' + kgEscape(c.content) + '">' +
          '<span class="kg-kind">' + kgEscape(c.kind) + '</span>' + kgEscape(c.content.slice(0, 40)) + '</div>';
      }).join('');
    }
    if (!els.kgCanvas._kgBound) {
      els.kgCanvas._kgBound = true;
      els.kgCanvas.addEventListener('click', function (ev) {
        var rect = els.kgCanvas.getBoundingClientRect();
        var x = (ev.clientX - rect.left) * (els.kgCanvas.width / rect.width);
        var y = (ev.clientY - rect.top) * (els.kgCanvas.height / rect.height);
        var hit = -1;
        graphPos.forEach(function (p, i) {
          if (Math.abs(p.x - x) < 14 && Math.abs(p.y - y) < 14) hit = i;
        });
        if (hit >= 0 && els.kgDetail) showKgDetail(hit);
      });
      if (els.kgList) {
        els.kgList.addEventListener('click', function (ev) {
          var item = ev.target.closest('.kg-item');
          if (item) showKgDetail(Number(item.dataset.i));
        });
      }
    }
  }

  function showKgDetail(i) {
    var p = graphPos[i];
    if (!p || !els.kgDetail) return;
    var c = p.card;
    els.kgDetail.textContent = c.kind + ' · ' + c.source + '\n' + c.content +
      (c.ref ? '\n出处：' + c.ref : '') + (c.tags.length ? '\n#' + c.tags.join(' #') : '');
  }

  function kgEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 数据流：把插件清单里的共享通道可视化 ---------- */
  function flowChannels() {
    var map = Object.create(null);
    APP_LIST.forEach(function (app) {
      (app.share && app.share.channels || []).forEach(function (ch) {
        if (!ch || !ch.id) return;
        if (!map[ch.id]) map[ch.id] = { id: ch.id, apps: [] };
        map[ch.id].apps.push({
          id: app.id, name: app.name || app.id, role: ch.role || 'both',
        });
      });
    });
    return Object.keys(map).map(function (id) {
      return map[id];
    });
  }

  function pushFlowEvent(kind, text) {
    flowEvents.unshift({ kind: kind, text: String(text || ''), at: Date.now() });
    if (flowEvents.length > 30) flowEvents.length = 30;
    if (flowOpen) renderDataFlow();
  }

  function openDataFlow() {
    if (!els.dataFlow) return;
    closePopovers();
    closeCommandPalette();
    closePluginPanel();
    closeGlobalSearch();
    closeTimeline();
    if (graphOpen) closeKnowledgeGraph();
    if (els.hubSettings) els.hubSettings.hidden = true;
    flowOpen = true;
    els.dataFlow.hidden = false;
    renderDataFlow();
  }

  function closeDataFlow() {
    flowOpen = false;
    if (els.dataFlow) els.dataFlow.hidden = true;
  }

  function renderDataFlow() {
    if (!els.flowChannels) return;
    var channels = flowChannels();
    var roleLabel = { both: '双向', publish: '发布', consume: '消费' };
    els.flowChannels.innerHTML = channels.length
      ? channels.map(function (ch) {
          var chips = ch.apps.map(function (a) {
            return '<span class="flow-chip ' + a.role + '" title="' + a.id + '">' +
              kgEscape(a.name) + ' · ' + (roleLabel[a.role] || a.role) + '</span>';
          }).join('');
          return '<div class="flow-channel"><div class="fc-name">' + kgEscape(ch.id) +
            '</div><div class="fc-apps">' + chips + '</div></div>';
        }).join('')
      : '<div class="kg-detail">当前插件清单没有声明共享通道。</div>';
    if (els.flowStatus) {
      els.flowStatus.textContent = channels.length + ' 个共享通道 · ' +
        flowEvents.length + ' 条近期流转';
    }
    if (els.flowEventList) {
      els.flowEventList.innerHTML = flowEvents.length
        ? flowEvents.slice(0, 12).map(function (ev) {
            return '<div class="flow-event"><span class="fe-time">' +
              new Date(ev.at).toLocaleTimeString() + '</span>' + kgEscape(ev.text) + '</div>';
          }).join('')
        : '<div class="kg-detail">暂无流转记录</div>';
    }
  }

  /* ---------- 今日：聚合各产品既有 localStorage，不新增存储 ---------- */
  function buildTodaySummary(input) {
    var data = input || {}
    var cards = Array.isArray(data.cards) ? data.cards : []
    var srs = Array.isArray(data.srs) ? data.srs : []
    var docs = data.docs && data.docs.meta ? data.docs.meta : {}
    var history = Array.isArray(data.search && data.search.history)
      ? data.search.history : []
    var rules = Array.isArray(data.rules) ? data.rules : []
    var now = Number(data.now) || Date.now()
    var due = srs.filter(function (s) {
      return s && Number(s.due || 0) <= now
    }).length
    var docIds = Object.keys(docs)
    return {
      cards: cards.length,
      due: due,
      notes: docIds.length,
      rules: rules.length,
      activeRules: rules.filter(function (r) { return r && r.enabled !== false }).length,
      recentNotes: docIds.slice(-3).reverse().map(function (id) {
        return { id: id, name: (docs[id] && docs[id].name) || id }
      }),
      recentSearches: history.slice(-3).reverse().map(function (h) {
        return h && h.query ? String(h.query) : ''
      }).filter(Boolean),
    }
  }

  function todayRead(key, fallback) {
    try {
      var raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch (e) {
      return fallback
    }
  }

  function renderToday(summary) {
    if (!els.todayBody) return
    var s = summary || buildTodaySummary({})
    var tiles = [
      { label: '待复习', value: s.due, app: 'zencard', hint: '张到期卡片' },
      { label: '知识卡片', value: s.cards, app: 'zencard', hint: '张累计' },
      { label: '笔记画布', value: s.notes, app: 'writer', hint: '篇' },
      { label: '自动化规则', value: s.rules, app: 'zenflow', hint: s.activeRules + ' 条启用' },
    ]
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px">'
    tiles.forEach(function (t) {
      html += '<button type="button" class="btn" data-today-app="' + t.app +
        '" style="text-align:left;padding:10px"><div class="oc-muted" style="font-size:11px">' +
        esc(t.label) + '</div><div style="font-size:22px;font-weight:600">' + t.value +
        '</div><div class="oc-muted" style="font-size:10px">' + esc(t.hint) + '</div></button>'
    })
    html += '</div>'
    html += '<div class="pp-status" style="margin-top:14px">最近笔记</div>'
    html += s.recentNotes.length
      ? s.recentNotes.map(function (n) {
          return '<button type="button" class="kg-detail" data-today-note="' + esc(n.id) +
            '" style="display:block;width:100%;text-align:left;cursor:pointer">' + esc(n.name) + '</button>'
        }).join('')
      : '<div class="kg-detail">暂无笔记</div>'
    html += '<div class="pp-status" style="margin-top:14px">最近搜索</div>'
    html += s.recentSearches.length
      ? s.recentSearches.map(function (q) {
          return '<button type="button" class="kg-detail" data-today-search="' + esc(q) +
            '" style="display:block;width:100%;text-align:left;cursor:pointer">' + esc(q) + '</button>'
        }).join('')
      : '<div class="kg-detail">暂无搜索历史</div>'
    els.todayBody.innerHTML = html
    if (els.todayStatus) {
      els.todayStatus.textContent = s.due + ' 张待复习 · ' + s.notes + ' 篇笔记 · ' +
        s.activeRules + '/' + s.rules + ' 条规则启用中'
    }
  }

  function openToday() {
    if (!els.todayPanel) return
    closePopovers();
    closeCommandPalette();
    closePluginPanel();
    closeGlobalSearch();
    closeTimeline();
    if (graphOpen) closeKnowledgeGraph();
    if (flowOpen) closeDataFlow();
    if (els.hubSettings) els.hubSettings.hidden = true;
    todayOpen = true;
    els.todayPanel.hidden = false;
    renderToday(buildTodaySummary({
      cards: todayRead('zen.cards.v1', []),
      srs: todayRead('zen.srs.v1', []),
      docs: todayRead('zc-docs', null),
      search: todayRead('omm-search-v1', null),
      rules: todayRead('zen.flow.rules.v1', []),
      now: Date.now(),
    }));
  }

  function closeToday() {
    todayOpen = false;
    if (els.todayPanel) els.todayPanel.hidden = true;
  }

  function gsearchEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function gsearchHighlight(text, needle) {
    var out = gsearchEscape(text);
    var token = gsearchEscape(needle).trim();
    if (!token) return out;
    try {
      var re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return out.replace(re, function (m) { return '<mark>' + m + '</mark>'; });
    } catch (e) { return out; }
  }

  function runGlobalSearch() {
    if (!els.gsearch) return;
    var q = els.gsearchInput.value.trim();
    gsearchSeq += 1;
    var seq = gsearchSeq;
    window.clearTimeout(gsearchTimer);
    if (!q) {
      gsearchResults = [];
      renderGlobalSearch(null, '输入关键词，检索全部产品中已保存的文档内容。');
      return;
    }
    renderGlobalSearch(null, '正在检索“' + gsearchEscape(q) + '”…', true);
    gsearchTimer = window.setTimeout(function () {
      fetch('/__omm/fs/search?q=' + encodeURIComponent(q) + '&all=1&limit=60', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (seq !== gsearchSeq || !gsearchOpen) return;
          if (!data || !data.matches) {
            renderGlobalSearch(null, '检索服务不可用（仅桌面版支持）。');
            return;
          }
          gsearchResults = data.matches || [];
          gsearchIndex = 0;
          var meta = '找到 ' + gsearchResults.length + ' 处匹配 · 扫描 ' +
            (data.scanned || 0) + ' 个文件';
          if (data.truncated) meta += '（结果较多，已截断）';
          renderGlobalSearch(q, meta);
        })
        .catch(function () {
          if (seq === gsearchSeq && gsearchOpen) renderGlobalSearch(null, '检索失败，请稍后重试。');
        });
    }, 220);
  }

  function renderGlobalSearch(needle, meta, loading) {
    if (!els.gsearch) return;
    if (els.gsearchMeta) els.gsearchMeta.innerHTML = meta || '';
    if (loading) {
      els.gsearchList.innerHTML = '<div class="gsearch-loading">正在检索全部产品内容…</div>';
      return;
    }
    if (!gsearchResults.length) {
      els.gsearchList.innerHTML = '<div class="cmdk-empty">' +
        (needle ? '没有找到与“' + gsearchEscape(needle) + '”相关的内容' : '输入关键词开始检索') +
        '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < gsearchResults.length; i++) {
      var m = gsearchResults[i];
      var app = APP_BY_ID[m.app];
      var appName = (app && app.name) || m.app_name || m.app || '未知产品';
      var glyph = (app && app.glyph) || appName.charAt(0);
      var snippet = gsearchHighlight(m.snippet || m.title || '', needle || '');
      html += '<button class="cmdk-item gsearch-item' + (i === gsearchIndex ? ' active' : '') +
        '" type="button" data-gs="' + i + '">' +
        '<span class="glyph">' + gsearchEscape(glyph) + '</span>' +
        '<span class="g-body">' +
        '<span class="g-title"><span class="g-name">' + gsearchEscape(m.title || m.name || '未命名') +
        '</span><span class="g-app">' + gsearchEscape(appName) + '</span></span>' +
        '<span class="g-snippet">' + snippet + '</span>' +
        '</span>' +
        '<span class="g-count">' + (m.count || 1) + ' 处</span>' +
        '</button>';
    }
    els.gsearchList.innerHTML = html;
    var active = els.gsearchList.querySelector('.gsearch-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function moveGsearch(delta) {
    if (!gsearchResults.length) return;
    gsearchIndex = (gsearchIndex + delta + gsearchResults.length) % gsearchResults.length;
    renderGlobalSearch(els.gsearchInput.value.trim(), null);
  }

  function openGsearchResult(index) {
    var m = gsearchResults[index];
    if (!m || !m.path) return;
    closeGlobalSearch();
    window.dispatchEvent(new CustomEvent('omm:load-file', {
      detail: { path: m.path, name: m.name || m.title, mime: m.mime, app: m.app }
    }));
  }

  /* ---------- 静心专注模式：番茄钟 + 离线环境音 + 免打扰 ---------- */
  function stopZenSound() {
    var src = zenSource;
    var ctx = zenAudio;
    var nodes = zenNodes;
    zenSource = null;
    zenAudio = null;
    zenNodes = [];
    if (!ctx) return;
    try {
      if (src) {
        var g = nodes[1];
        if (g) g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
      }
    } catch (e) { /* ignore */ }
    // 必须等淡出结束再 stop + close，否则 AudioContext 会立刻切断声音（爆音）。
    var finish = function () {
      try { if (src) src.stop(); } catch (e) {}
      nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
      try { ctx.close(); } catch (e) {}
    };
    if (src) window.setTimeout(finish, 320);
    else finish();
  }

  function setZenSound(kind) {
    hubAppearance.focus.sound = kind;
    saveHubAppearance();
    var select = document.getElementById('hub-focus-sound');
    if (select) select.value = kind;
    stopZenSound();
    if (!kind || kind === 'none') { renderZen(); return; }
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { toast('此环境不支持网页音频', 'error'); renderZen(); return; }
    try {
      zenAudio = new Ctx();
      var buffer = zenAudio.createBuffer(1, zenAudio.sampleRate * 3, zenAudio.sampleRate);
      var data = buffer.getChannelData(0);
      var last = 0;
      for (var i = 0; i < data.length; i++) {
        var white = Math.random() * 2 - 1;
        if (kind === 'noise') {
          data[i] = white * 0.22;
        } else if (kind === 'coffee') {
          last = (last + 0.02 * white) / 1.02;
          data[i] = last * 2.6 * 0.5 + white * 0.018;
        } else {
          last = (last + 0.035 * white) / 1.035;
          data[i] = last * 2.8 * 0.4 + white * 0.1;
        }
      }
      var source = zenAudio.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      var filter = zenAudio.createBiquadFilter();
      filter.type = kind === 'noise' ? 'bandpass' : 'lowpass';
      filter.frequency.value = kind === 'rain' ? 1500 : (kind === 'coffee' ? 700 : 1200);
      var gain = zenAudio.createGain();
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(zenAudio.destination);
      source.start();
      gain.gain.linearRampToValueAtTime(0.16, zenAudio.currentTime + 1.2);
      zenSource = source;
      zenNodes = [filter, gain];
    } catch (e) {
      stopZenSound();
      toast('环境音启动失败', 'error');
    }
    renderZen();
  }

  function playZenChime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      [660, 880].forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.18);
        gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + i * 0.18 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.18);
        osc.stop(ctx.currentTime + i * 0.18 + 0.55);
      });
      window.setTimeout(function () { try { ctx.close(); } catch (e) {} }, 1600);
    } catch (e) { /* ignore */ }
  }

  function renderZen() {
    if (!els.zenBar) return;
    var total = zenTotal || 1;
    var pct = Math.max(0, Math.min(1, zenRemaining / total));
    if (els.zenProgress) els.zenProgress.style.strokeDashoffset = String(119.4 * (1 - pct));
    var mins = Math.floor(Math.max(0, zenRemaining) / 60);
    var secs = Math.max(0, zenRemaining) % 60;
    if (els.zenClock) els.zenClock.textContent = (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
    if (els.zenModeLabel) els.zenModeLabel.textContent = zenPhase === 'focus' ? '专注时间' : '短暂休息';
    if (els.zenHint) els.zenHint.textContent = zenRunning
      ? (zenPhase === 'focus' ? '保持沉浸，暂离纷扰' : '起身活动，放松眼睛')
      : '已暂停 · 点击开始继续';
    if (els.zenToggle) els.zenToggle.textContent = zenRunning ? '暂停' : '开始';
    if (els.zenSound) {
      var names = { none: '♪ 关', rain: '♪ 雨声', noise: '♪ 白噪', coffee: '♪ 咖啡馆' };
      els.zenSound.textContent = names[hubAppearance.focus.sound] || '♪ 关';
    }
    els.zenBar.classList.toggle('running', zenRunning);
  }

  function zenTick() {
    if (!zenRunning || !zenActive) return;
    zenRemaining -= 1;
    if (zenRemaining <= 0) {
      playZenChime();
      if (zenPhase === 'focus') {
        zenPhase = 'break';
        zenTotal = (hubAppearance.focus.breakMin || 5) * 60;
        zenRemaining = zenTotal;
        zenRunning = true;
        toast('专注完成，休息一下 ☕');
      } else {
        zenPhase = 'focus';
        zenTotal = (hubAppearance.focus.pomodoro || 25) * 60;
        zenRemaining = zenTotal;
        zenRunning = false;
        toast('休息结束，准备下一轮');
      }
    }
    renderZen();
  }

  function setZen(active) {
    if (active === zenActive) return;
    zenActive = active;
    document.body.classList.toggle('zen-mode', active);
    document.body.classList.toggle('zen-dim', active && hubAppearance.focus.dim !== false);
    document.body.classList.toggle('zen-dnd', active && hubAppearance.focus.dnd !== false);
    if (els.zenBar) els.zenBar.hidden = !active;
    window.clearInterval(zenTimer);
    zenTimer = 0;
    if (!active) {
      zenRunning = false;
      stopZenSound();
      toast('已退出静心模式');
    } else {
      zenPhase = 'focus';
      zenTotal = (hubAppearance.focus.pomodoro || 25) * 60;
      zenRemaining = zenTotal;
      zenRunning = true;
      zenTimer = window.setInterval(zenTick, 1000);
      if (hubAppearance.focus.sound && hubAppearance.focus.sound !== 'none') {
        setZenSound(hubAppearance.focus.sound);
      }
      toast('静心模式已开启 · 保持沉浸');
    }
    renderZen();
    applyHubAppearance();
  }

  /* ---------- 最近动态：跨产品时间线 ---------- */
  function timelineTime(value) {
    if (typeof value === 'number') return value;
    if (!value) return 0;
    var t = Date.parse(String(value).replace(' ', 'T'));
    return isFinite(t) ? t : 0;
  }

  function timelineDay(value) {
    var t = timelineTime(value);
    if (!t) return '时间未知';
    var d = new Date(t);
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return '今天';
    var yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return '昨天';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function openTimeline() {
    if (!els.timelinePanel) return;
    closePopovers();
    closeCommandPalette();
    closeGlobalSearch();
    closePluginPanel();
    if (els.hubSettings) els.hubSettings.hidden = true;
    timelineOpen = true;
    els.timelinePanel.hidden = false;
    timelineFilter = 'all';
    Array.prototype.forEach.call(document.querySelectorAll('[data-tl]'), function (btn) {
      btn.classList.toggle('active', btn.dataset.tl === 'all');
    });
    loadTimeline();
  }

  function closeTimeline() {
    if (!els.timelinePanel) return;
    timelineOpen = false;
    els.timelinePanel.hidden = true;
  }

  function loadTimeline() {
    if (!els.timelineList) return;
    els.timelineList.innerHTML = '<div class="tl-empty">正在汇总最近动态…</div>';
    var archivePromise = fetch('/__omm/fs/archive?all=1&limit=120', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { entries: [] }; })
      .catch(function () { return { entries: [] }; });
    var sharePromise = (window.OMMShare && window.OMMShare.loadSpace)
      ? window.OMMShare.loadSpace().catch(function () { return null; })
      : Promise.resolve(null);
    Promise.all([archivePromise, sharePromise]).then(function (results) {
      if (!timelineOpen) return;
      var archive = results[0] || {};
      var space = results[1];
      var events = [];
      (archive.entries || []).forEach(function (entry) {
        var kind = entry.kind === 'snapshot' ? 'snapshot' : 'file';
        var app = APP_BY_ID[entry.app];
        events.push({
          type: kind,
          time: entry.time || entry.updated || entry.mtime || '',
          title: entry.name || entry.label || entry.title || '未命名',
          sub: ((app && app.name) || entry.app_name || entry.app || '') +
            (kind === 'snapshot' ? ' · ' + (entry.label || '自动快照') : ' · 已保存文档'),
          glyph: kind === 'snapshot' ? '快' : ((app && app.glyph) || '文'),
          data: entry,
        });
      });
      ((space && space.items) || []).forEach(function (item) {
        events.push({
          type: 'share',
          time: item.created || item.at || item.time || '',
          title: item.title || '共享项目',
          sub: '共享到 ' + (item.channel || '共享空间') + ' · ' + (item.source_name || ''),
          glyph: '享',
          data: item,
        });
      });
      (notifications || []).forEach(function (note) {
        events.push({
          type: 'notify',
          time: note.at || 0,
          title: note.title || '通知',
          sub: note.body || '工作台通知',
          glyph: '知',
          data: note,
        });
      });
      events.sort(function (a, b) { return timelineTime(b.time) - timelineTime(a.time); });
      timelineEvents = events;
      renderTimeline();
    });
  }

  function renderTimeline() {
    if (!els.timelineList) return;
    var items = timelineEvents.filter(function (e) {
      return timelineFilter === 'all' || e.type === timelineFilter;
    });
    if (!items.length) {
      els.timelineList.innerHTML = '<div class="tl-empty">这个分类还没有记录。</div>';
      return;
    }
    var html = '';
    var lastDay = '';
    items.forEach(function (e, index) {
      var day = timelineDay(e.time);
      if (day !== lastDay) { html += '<div class="tl-day">' + esc(day) + '</div>'; lastDay = day; }
      var label = { file: '文档', snapshot: '快照', share: '共享', notify: '通知' }[e.type] || '';
      html += '<button class="tl-item" type="button" data-tl-item="' + index + '">' +
        '<span class="tl-glyph">' + gsearchEscape(e.glyph) + '</span>' +
        '<span class="tl-main"><span class="tl-title">' + esc(e.title) + '</span>' +
        '<span class="tl-sub">' + esc(e.sub) + ' · ' + esc(notifyTime(e.time)) + '</span></span>' +
        '<span class="tl-kind">' + label + '</span></button>';
    });
    els.timelineList.innerHTML = html;
  }

  function openTimelineItem(index) {
    var e = timelineEvents.filter(function (item) {
      return timelineFilter === 'all' || item.type === timelineFilter;
    })[index];
    if (!e) return;
    var d = e.data || {};
    if (e.type === 'file') {
      closeTimeline();
      window.dispatchEvent(new CustomEvent('omm:load-file', {
        detail: { path: d.path, name: d.name, mime: d.mime, app: d.app }
      }));
    } else if (e.type === 'snapshot') {
      closeTimeline();
      window.dispatchEvent(new CustomEvent('omm:restore-snapshot', {
        detail: { path: d.path, app: d.app, name: d.name, label: d.label }
      }));
    } else if (e.type === 'share') {
      var space = cmdkSpace || {};
      var channel = (space.channels || []).filter(function (c) { return c.id === d.channel; })[0];
      var target = channel && (channel.apps || []).filter(function (a) { return a.consume; })[0];
      if (target && window.OMMShare) {
        closeTimeline();
        window.OMMShare.openArtifact(d, target);
      } else {
        toast('找不到该共享项目的接收产品');
      }
    } else if (e.type === 'notify') {
      if (d.app && APP_BY_ID[d.app]) { closeTimeline(); activateApp(d.app); }
      else toast(d.body || d.title || '通知');
    }
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
      '<button class="menu-item" type="button" data-tab-ctx="detach"><span class="check"></span>脱离为独立窗口</button>' +
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
        toast('已在浏览器窗口打开“' + name + '”');
      })
      .catch(function () {
        appUrlFor(appId)
          .then(function (url) {
            window.open(url, '_blank', 'noopener,width=1280,height=860');
            toast('已在新窗口打开“' + name + '”');
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
      else if (act === 'globalsearch') openGlobalSearch();
      else if (act === 'graph') { if (graphOpen) closeKnowledgeGraph(); else openKnowledgeGraph(); }
      else if (act === 'flow') { if (flowOpen) closeDataFlow(); else openDataFlow(); }
      else if (act === 'today') { if (todayOpen) closeToday(); else openToday(); }
      else if (act === 'zen') setZen(!zenActive);
      else if (act === 'timeline') { if (timelineOpen) closeTimeline(); else openTimeline(); }
      else if (act === 'notify') toggleNotifyPanel();
      else if (act === 'settings') openHubSettings();
      else if (act === 'launcher') toggleLauncher();
      else if (act === 'archive') toggleArchive();
    });
    els.brand.addEventListener('click', function () {
      toggleLauncher();
    });
    if (els.knowledgeGraph) {
      els.knowledgeGraph.addEventListener('click', function (event) {
        if (event.target === els.knowledgeGraph || event.target.closest('#kg-close')) {
          closeKnowledgeGraph();
        }
      });
    }
    if (els.dataFlow) {
      els.dataFlow.addEventListener('click', function (event) {
        if (event.target === els.dataFlow || event.target.closest('#flow-close')) {
          closeDataFlow();
        }
      });
    }
    if (els.todayPanel) {
      els.todayPanel.addEventListener('click', function (event) {
        if (event.target === els.todayPanel || event.target.closest('#today-close')) {
          closeToday();
          return;
        }
        var tile = event.target.closest('[data-today-app]');
        if (tile) { closeToday(); activateApp(tile.dataset.todayApp); return; }
        if (event.target.closest('[data-today-note]')) { closeToday(); activateApp('writer'); return; }
        if (event.target.closest('[data-today-search]')) { closeToday(); activateApp('search'); return; }
      });
    }

    /* 全局内容搜索 */
    if (els.gsearch) {
      els.gsearch.addEventListener('click', function (event) {
        if (event.target === els.gsearch || event.target.closest('#gsearch-close')) {
          closeGlobalSearch();
          return;
        }
        var item = event.target.closest('[data-gs]');
        if (item) openGsearchResult(Number(item.dataset.gs));
      });
      els.gsearchInput.addEventListener('input', function () {
        gsearchIndex = 0;
        runGlobalSearch();
      });
    }

    /* 静心专注浮条 */
    if (els.zenBar) {
      els.zenToggle.addEventListener('click', function () { zenRunning = !zenRunning; renderZen(); });
      els.zenSkip.addEventListener('click', function () {
        playZenChime();
        if (zenPhase === 'focus') {
          zenPhase = 'break';
          zenTotal = (hubAppearance.focus.breakMin || 5) * 60;
        } else {
          zenPhase = 'focus';
          zenTotal = (hubAppearance.focus.pomodoro || 25) * 60;
        }
        zenRemaining = zenTotal;
        renderZen();
      });
      els.zenSound.addEventListener('click', function () {
        var order = ['none', 'rain', 'noise', 'coffee'];
        var current = order.indexOf(hubAppearance.focus.sound);
        setZenSound(order[(current + 1) % order.length]);
      });
      els.zenExit.addEventListener('click', function () { setZen(false); });
    }

    /* 最近动态 */
    if (els.timelinePanel) {
      var closeTimelineBtn = document.getElementById('timeline-close');
      if (closeTimelineBtn) closeTimelineBtn.addEventListener('click', closeTimeline);
      els.timelinePanel.addEventListener('click', function (event) {
        if (event.target === els.timelinePanel) { closeTimeline(); return; }
        var tab = event.target.closest('[data-tl]');
        if (tab) {
          timelineFilter = tab.dataset.tl;
          Array.prototype.forEach.call(document.querySelectorAll('[data-tl]'), function (btn) {
            btn.classList.toggle('active', btn === tab);
          });
          renderTimeline();
          return;
        }
        var item = event.target.closest('[data-tl-item]');
        if (item) openTimelineItem(Number(item.dataset.tlItem));
      });
    }
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
        if (note && note.app) {
          // 启动失败的通知指向的 iframe 可能仍存在，activateApp 只会切到它、
          // 不会真正重试；失败状态下应走 retryApp。
          if (appStatus[note.app] === 'error') retryApp(note.app);
          else activateApp(note.app);
        }
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
        } else if (tabAction === 'detach') detachApp(tabApp);
        else if (tabAction === 'window') openAppWindow(tabApp);
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
        else if (name === 'detail') showPluginDetail(id);
        else if (name === 'detail-back') renderPluginPanel();
        else if (name === 'rollback') rollbackPlugin(id);
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
      // 窗口身份 + origin 双重校验：iframe 来自各插件独立的 loopback 端口，
      // 期望 origin 必须从该 frame 自己的 URL 推导。
      if (event.origin !== frameTargetOrigin(sourceFrame) || !isLoopbackOrigin(event.origin)) return;
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
      if (data.type === 'omm:restore-done') {
        if (data.ok === false) toast('恢复失败：' + (data.error || '未知错误'), 'error');
        else toast('快照已恢复');
        return;
      }
      if (data.type === 'omm:share-open') {
        openSharedApp(appIdFromMessage(data.app));
        return;
      }
      if (data.type === 'omm:zen-card-reply') {
        // A live-data request reuses the card protocol: feed any active waiter.
        var waiter = liveDataWaiters[data.token];
        if (waiter && Array.isArray(data.cards)) {
          data.cards.slice(0, 200).forEach(function (c) {
            var n = kgNormalize(c);
            if (n) waiter.snapshot.cards.push({
              content: n.content, kind: n.kind, tags: n.tags, source: n.source
            });
          });
        }
        if (!graphOpen || !Array.isArray(data.cards)) return;
        var incoming = data.cards.map(kgNormalize).filter(Boolean);
        graphCards = dedupeGraphCards(graphCards.concat(incoming));
        renderKnowledgeGraph();
        pushFlowEvent('card', '收到 ' + (sourceApp || '产品') + ' 的 ' + incoming.length + ' 张卡片');
        return;
      }
      if (data.type === 'omm:live-data-request') {
        respondLiveData(sourceFrame, event.origin);
        return;
      }
      if (data.type === 'omm:review-card') {
        // A Writer citation asks us to jump to ZenCard and highlight a card.
        var cardId = String(data.cardId || '');
        if (!cardId) return;
        activateApp('zencard');
        whenAppReady('zencard', function (frame) {
          if (!frame) return;
          try {
            frame.contentWindow.postMessage(
              { type: 'omm:focus-card', cardId: cardId }, frameTargetOrigin(frame)
            );
          } catch (e) { /* ignore */ }
        });
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
          '“' + targetName + '”收到：' + (data.title || '共享项目'),
          { app: targetApp, kind: 'share' }
        );
        pushFlowEvent('share', sourceApp + ' → ' + targetApp + '：' + (data.title || '共享项目'));
        return;
      }
      if (data.type === 'omm:pointerdown') {
        /* A click anywhere outside the archive panel dismisses it, including
           clicks inside a product iframe (they never reach this document). */
        if (
          !els.launcher.hidden ||
          !els.layoutMenu.hidden ||
          !els.ctxMenu.hidden ||
          (els.notifyPanel && !els.notifyPanel.hidden) ||
          graphOpen ||
          flowOpen
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

  function comboFromEvent(event) {
    var key = event.key;
    if (!key || ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].indexOf(key) >= 0) return '';
    var normalized = {
      '|': '\\', '+': '=', ':': ';', '?': '/', '<': ',', '>': '.',
      '_': '-', '~': '`', '"': "'",
    };
    var k = normalized[key] || key;
    if (k === ' ') k = 'Space';
    else if (/^Arrow/.test(k)) k = k.slice(5);
    else if (k.length === 1) k = k.toUpperCase();
    var parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(k);
    return parts.join('+');
  }

  function resolveCombo(combo) {
    if (!combo) return null;
    var map = hubAppearance.keymap || {};
    for (var id in map) {
      if (Object.prototype.hasOwnProperty.call(map, id) && map[id] === combo) {
        return { type: 'command', value: id };
      }
    }
    var macros = hubAppearance.macros || [];
    for (var i = 0; i < macros.length; i++) {
      if (macros[i].key && macros[i].key === combo) return { type: 'macro', value: i };
    }
    return null;
  }

  function runMacro(index) {
    var macro = (hubAppearance.macros || [])[index];
    if (!macro) return;
    toast('运行宏：' + macro.name);
    (macro.actions || []).forEach(function (action, i) {
      window.setTimeout(function () {
        if (/^open-[0-9]$/.test(action)) {
          handleShortcut('open-index', { index: parseInt(action.slice(5), 10) });
        } else if (action.indexOf('macro:') === 0) {
          var nested = parseInt(action.slice(6), 10);
          if (nested !== index && (hubAppearance.macros || [])[nested]) runMacro(nested);
        } else {
          handleShortcut(action, {});
        }
      }, i * 120);
    });
  }

  function onKeyDown(event) {
    if (comboCapturing) return;
    var mod = event.ctrlKey || event.metaKey;
    if (!mod) {
      if (gsearchOpen) {
        if (event.key === 'Escape') { closeGlobalSearch(); event.preventDefault(); return; }
        if (event.key === 'ArrowDown') { moveGsearch(1); event.preventDefault(); return; }
        if (event.key === 'ArrowUp') { moveGsearch(-1); event.preventDefault(); return; }
        if (event.key === 'Enter') { openGsearchResult(gsearchIndex); event.preventDefault(); return; }
      }
      if (event.key === 'Escape') {
        if (cmdkOpen) {
          closeCommandPalette();
          event.preventDefault();
        } else if (timelineOpen) {
          closeTimeline();
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
        } else if (zenActive) {
          setZen(false);
          event.preventDefault();
        } else if (state.maximized) {
          setMaximized(false);
          event.preventDefault();
        }
      }
      return;
    }

    var key = event.key;

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

    var combo = comboFromEvent(event);
    var hit = resolveCombo(combo);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    if (hit.type === 'macro') runMacro(hit.value);
    else if (/^open-[0-9]$/.test(hit.value)) {
      var n = parseInt(hit.value.slice(5), 10);
      handleShortcut('open-index', { index: n });
    } else handleShortcut(hit.value, {});
  }

  function handleShortcut(action, data) {
    if (action === 'command-palette') openCommandPalette();
    else if (action === 'global-search') openGlobalSearch();
    else if (action === 'knowledge-graph') openKnowledgeGraph();
    else if (action === 'data-flow') openDataFlow();
    else if (action === 'today') openToday();
    else if (action === 'zen-mode') setZen(!zenActive);
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
