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
  var pluginLoadError = '';
  var PLUGIN_DIR = '';
  var APPEARANCE_KEY = 'omm.hub.appearance.v1';
  var hubAppearance = { radius: 0, accent: 'amber', motion: true, topbar: true };

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
    } catch (e) {
      state = defaultState();
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
    els.toast = document.getElementById('toast');
    els.pluginPanel = document.getElementById('plugin-panel');
    els.ppBody = document.getElementById('pp-body');
    els.ppTitle = document.getElementById('pp-title');
    els.ppStatus = document.getElementById('pp-status');
    els.hubSettings = document.getElementById('hub-settings');

    loadHubAppearance();
    applyHubAppearance();
    bindHubSettings();

    ensureSplitKeys(state.tree);
    applyDockState();
    bindEvents();
    renderAll();

    loadPlugins(true);

    if (window.ResizeObserver) {
      new ResizeObserver(scheduleLayout).observe(els.workspace);
    }
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('beforeunload', saveNow);
    window.addEventListener('pagehide', saveNow);
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
          '<span class="tab-close" data-close="' +
          esc(appId) +
          '" role="button" title="关闭">×</span>' +
          '</button>'
        );
      })
      .join('');
    var active = els.tabs.querySelector('.tab.active');
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function buildDock() {
    var html = APP_LIST.map(function (app, index) {
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
      '<span class="glyph">⊞</span></button>';
    els.dock.innerHTML = html;
  }

  function renderDock() {
    if (!els.dock) return;
    var activeApp = paneApp(state.focused);
    Array.prototype.forEach.call(els.dock.querySelectorAll('.dock-app[data-app]'), function (el) {
      var appId = el.dataset.app;
      el.classList.toggle('running', state.open.indexOf(appId) >= 0);
      el.classList.toggle('active', activeApp === appId);
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
  }

  function renderLauncher() {
    if (!els.launcher) return;
    var grid = APP_LIST.map(function (app, index) {
      var key = index < 9 ? 'Ctrl+' + (index + 1) : '';
      var open = state.open.indexOf(app.id) >= 0;
      return (
        '<button class="launcher-app" type="button" data-app="' +
        esc(app.id) +
        '">' +
        '<span class="glyph' + appIconClass(app) + '">' +
        appIconHTML(app) +
        '</span>' +
        '<span class="meta"><span class="name">' +
        esc(app.name) +
        (open ? ' ·' : '') +
        '</span><span class="desc">' +
        esc(app.description || '') +
        '</span></span>' +
        (key ? '<span class="key">' + key + '</span>' : '') +
        '</button>'
      );
    }).join('');
    els.launcher.innerHTML =
      '<div class="launcher-head"><span class="launcher-title">所有应用</span>' +
      '<span class="launcher-sub">点击打开到当前窗格</span></div>' +
      '<div class="launcher-grid">' +
      grid +
      '</div>' +
      '<div class="launcher-foot"><span>Ctrl+0 打开此面板</span><span>拖动标签到窗格边缘可分屏</span><span>Ctrl+Shift+M 专注</span></div>';
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
      hubAppearance.accent = ['amber', 'olive', 'rust', 'blue'].indexOf(data.accent) >= 0
        ? data.accent
        : 'amber';
      hubAppearance.motion = data.motion !== false;
      hubAppearance.topbar = data.topbar !== false;
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
  }

  function applyHubAppearance() {
    if (!document.documentElement) return;
    document.documentElement.style.setProperty('--radius', hubAppearance.radius + 'px');
    document.documentElement.dataset.accent = hubAppearance.accent;
    document.body.classList.toggle('no-motion', !hubAppearance.motion);
    els.app.classList.toggle('topbar-hidden', !hubAppearance.topbar);
    Array.prototype.forEach.call(document.querySelectorAll('[data-hub-radius]'), function (btn) {
      btn.classList.toggle('active', Number(btn.dataset.hubRadius) === hubAppearance.radius);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-hub-accent]'), function (btn) {
      btn.classList.toggle('active', btn.dataset.hubAccent === hubAppearance.accent);
    });
    var motion = document.getElementById('hub-motion');
    if (motion) motion.setAttribute('aria-checked', String(hubAppearance.motion));
    var topbar = document.getElementById('hub-topbar');
    if (topbar) topbar.setAttribute('aria-checked', String(hubAppearance.topbar));
  }

  function openHubSettings() {
    closePopovers();
    closePluginPanel();
    els.hubSettings.hidden = false;
    applyHubAppearance();
  }

  function closeHubSettings() {
    els.hubSettings.hidden = true;
  }

  function bindHubSettings() {
    if (!els.hubSettings) return;
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
    document.getElementById('hub-settings-reset').addEventListener('click', function () {
      hubAppearance = { radius: 0, accent: 'amber', motion: true, topbar: true };
      saveHubAppearance();
      applyHubAppearance();
      scheduleLayout();
    });
  }

  function openPluginPanel(tab) {
    closePopovers();
    if (els.hubSettings) els.hubSettings.hidden = true;
    if (tab) pluginPanelTab = tab;
    els.pluginPanel.hidden = false;
    els.ppStatus.textContent = '按需安装产品，或导入自己的插件';
    renderPluginPanel();
  }

  function closePluginPanel() {
    els.pluginPanel.hidden = true;
    catalogCache = null;
  }

  function setPluginTab(tab) {
    pluginPanelTab = tab;
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
      '<div class="pp-list">' +
      rows +
      '</div>' +
      '<div class="pp-foot"><span>数据目录：' +
      esc(PLUGIN_DIR) +
      '</span><span>共 ' +
      APP_LIST.length +
      ' 个插件</span></div>';
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
    renderOnlinePlugins();
    closeTab(pluginId);
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
      .then(function () {
        toast('插件已安装');
        return refreshPluginsAfterChange();
      })
      .catch(function (error) {
        toast(error.message || '安装失败');
      })
      .finally(function () {
        pluginBusy[pluginId] = false;
        if (pluginPanelTab === 'online') renderPluginPanel();
      });
  }

  function removePlugin(pluginId) {
    var app = appOf(pluginId);
    if (!app) return;
    if (!window.confirm('卸载「' + app.name + '」？本地数据会保留。')) return;
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
        if (data.plugin && data.plugin.id) closeTab(data.plugin.id);
        toast('已导入「' + (data.plugin ? data.plugin.name : file.name) + '」');
        els.ppStatus.textContent = '插件导入成功';
        return refreshPluginsAfterChange();
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
    els.launcher.hidden = true;
    els.layoutMenu.hidden = true;
    els.ctxMenu.hidden = true;
  }

  function toggleLauncher(force) {
    var show = typeof force === 'boolean' ? force : !launcherOpen;
    closePopovers();
    if (!show) return;
    renderLauncher();
    els.launcher.hidden = false;
    launcherOpen = true;
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
      return (
        '<div class="empty-wrap"><div class="empty-title">选择一个应用</div>' +
        '<div class="empty-sub">点击打开，或把顶部标签拖到窗格边缘分屏</div>' +
        '<div class="app-grid">' +
        grid +
        '</div></div>'
      );
    }
    if (status === 'loading' || status === 'idle') {
      return (
        '<div class="loading-box"><span class="spinner"></span><span>正在启动「' +
        esc(app.name) +
        '」…</span></div>'
      );
    }
    if (status === 'error') {
      return (
        '<div class="error-box"><strong>无法启动「' +
        esc(app.name) +
        '」</strong><span>' +
        esc(appErrors[app.id] || '本地服务没有响应') +
        '</span><button class="retry-btn" type="button" data-act="retry" data-app="' +
        esc(app.id) +
        '">重试</button></div>'
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
    delete appErrors[appId];
    refreshApp(appId);

    loadTimers[appId] = window.setTimeout(function () {
      if (appStatus[appId] !== 'loading') return;
      appStatus[appId] = 'error';
      appErrors[appId] = '页面加载超时';
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
    var existing = findPaneByApp(appId);
    if (existing) {
      setFocused(existing);
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
    state.panes[paneId] = appId;
    if (state.open.indexOf(appId) < 0) state.open.push(appId);
    state.focused = paneId;
    if (state.maximized) state.maximized = paneId;
    mountApp(appId);
    renderAll();
    save();
  }

  function closeTab(appId) {
    state.open = state.open.filter(function (id) {
      return id !== appId;
    });
    var pane = findPaneByApp(appId);
    if (pane) state.panes[pane] = null;
    destroyFrame(appId);
    if (state.maximized && !paneApp(state.maximized)) state.maximized = null;
    renderAll();
    save();
  }

  function splitPane(paneId, dir, side, appId) {
    var leaf = findLeafNode(paneId);
    if (!leaf) return;
    if (appId && findPaneByApp(appId) === paneId) {
      toast('这个应用已经在该窗格中');
      return;
    }
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
      if (oldPane && oldPane !== paneId) state.panes[oldPane] = null;
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
      else if (act === 'settings') openHubSettings();
      else if (act === 'launcher') toggleLauncher();
    });
    els.brand.addEventListener('click', function () {
      toggleLauncher();
    });
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
      var item = event.target.closest('[data-app]');
      if (!item) return;
      activateApp(item.dataset.app);
      toggleLauncher(false);
    });

    /* layout menu */
    els.layoutMenu.addEventListener('click', function (event) {
      var item = event.target.closest('[data-preset]');
      if (!item) return;
      applyPreset(item.dataset.preset);
      els.layoutMenu.hidden = true;
    });

    /* context menu */
    els.ctxMenu.addEventListener('click', function (event) {
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
          renderPluginPanel();
        } else if (name === 'pick-file') {
          var input = document.getElementById('pp-file');
          if (input) input.click();
        } else if (name === 'show-spec') {
          setPluginTab('spec');
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
      var action = event.target.closest('[data-act]');
      if (!action) return;
      if (action.dataset.act === 'open-plugins') openPluginPanel('online');
      else if (action.dataset.act === 'pane-split-v') splitPane(paneId, 'v', 'right', null);
      else if (action.dataset.act === 'pane-split-h') splitPane(paneId, 'h', 'bottom', null);
      else if (action.dataset.act === 'pane-close') closePane(paneId);
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
      if (!dragApp) return;
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = 'move';
      } catch (e) {
        /* ignore */
      }
      updateDropHint(event);
    });
    els.dropLayer.addEventListener('dragleave', function (event) {
      if (event.relatedTarget && els.dropLayer.contains(event.relatedTarget)) return;
      dragTarget = null;
      els.dropHint.classList.remove('on');
    });
    els.dropLayer.addEventListener('drop', function (event) {
      event.preventDefault();
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
        event.target.closest('#brand') ||
        event.target.closest('#tab-add') ||
        event.target.closest('[data-act="layout"]') ||
        event.target.closest('[data-act="launcher"]')
      ) {
        return;
      }
      if (!els.launcher.hidden || !els.layoutMenu.hidden || !els.ctxMenu.hidden) {
        closePopovers();
      }
    });
    els.launcher.addEventListener('contextmenu', function (event) {
      event.preventDefault();
    });

    /* keyboard */
    window.addEventListener('keydown', onKeyDown, true);

    /* shortcuts forwarded from product iframes */
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || data.type !== 'omm:shortcut') return;
      var fromOurs = false;
      var sourceApp = null;
      frames.forEach(function (frame) {
        if (!fromOurs && frame.contentWindow === event.source) {
          fromOurs = true;
          sourceApp = frame.dataset.app;
        }
      });
      if (!fromOurs) return;
      if (sourceApp) {
        var pane = findPaneByApp(sourceApp);
        if (pane) setFocused(pane);
      }
      handleShortcut(data.action, data);
    });
  }

  function onKeyDown(event) {
    var mod = event.ctrlKey || event.metaKey;
    if (!mod) {
      if (event.key === 'Escape') {
        if (!els.hubSettings.hidden) {
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

    if (key === 'Tab') action = event.shiftKey ? 'prev-tab' : 'next-tab';
    else if (lower === 'w') action = 'close-tab';
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
    if (action === 'next-tab') cycleTab(1);
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
