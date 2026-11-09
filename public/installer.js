(function () {
  'use strict';

  var state = {
    config: null,
    catalog: null,
    selected: new Set(),
    poll: 0,
    installing: false,
  };

  var APPEARANCE_KEY = 'omm.installer.appearance.v1';
  var appearance = { radius: 0, accent: 'amber', motion: true, compact: false };

  var els = {};

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function bytes(value) {
    if (!value) return '0 MB';
    if (value < 1024 * 1024) return Math.round(value / 1024) + ' KB';
    return (value / 1024 / 1024).toFixed(1) + ' MB';
  }

  function api(url, options) {
    return fetch(url, options || {}).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok || data.ok === false) {
          throw new Error(data.error || '请求失败（' + response.status + '）');
        }
        return data;
      });
    });
  }

  function init() {
    els.grid = document.getElementById('grid');
    els.dir = document.getElementById('dir');
    els.pluginDir = document.getElementById('plugin-dir');
    els.platform = document.getElementById('platform');
    els.version = document.getElementById('version');
    els.summaryCount = document.getElementById('summary-count');
    els.summarySize = document.getElementById('summary-size');
    els.summaryState = document.getElementById('summary-state');
    els.install = document.getElementById('install');
    els.retry = document.getElementById('retry');
    els.progressPanel = document.getElementById('progress-panel');
    els.progressMessage = document.getElementById('progress-message');
    els.progressPercent = document.getElementById('progress-percent');
    els.progressBar = document.getElementById('progress-bar');
    els.progressLog = document.getElementById('progress-log');
    els.done = document.getElementById('done');
    els.shortcut = document.getElementById('shortcut');
    els.railCount = document.getElementById('rail-count');
    els.railSize = document.getElementById('rail-size');
    els.settings = document.getElementById('settings');

    loadAppearance();
    applyAppearance();
    bindSettings();

    document.getElementById('select-all').addEventListener('click', function () {
      if (!state.catalog) return;
      state.catalog.plugins.forEach(function (item) {
        state.selected.add(item.id);
      });
      renderPlugins();
    });
    document.getElementById('select-none').addEventListener('click', function () {
      state.selected.clear();
      renderPlugins();
    });
    document.getElementById('browse').addEventListener('click', browse);
    els.install.addEventListener('click', startInstall);
    els.retry.addEventListener('click', loadCatalog);
    document.getElementById('launch').addEventListener('click', launch);
    document.getElementById('close-done').addEventListener('click', function () {
      els.done.hidden = true;
    });

    loadConfig().then(loadCatalog);
  }

  function loadConfig() {
    return api('/api/config')
      .then(function (config) {
        state.config = config;
        els.dir.value = config.install_dir;
        els.pluginDir.textContent = config.plugin_dir;
        els.platform.textContent = {
          win64: 'Windows 64-bit',
          'macos-arm64': 'macOS Apple Silicon',
          'macos-x86_64': 'macOS Intel',
        }[config.platform] || config.platform;
        els.version.textContent = 'v' + config.version;
        if (config.platform !== 'win64') {
          els.shortcut.checked = false;
          els.shortcut.closest('.check-line').style.display = 'none';
        }
        els.install.textContent = '开始安装';
      })
      .catch(function (error) {
        els.grid.innerHTML = '<div class="empty">' + esc(error.message) + '</div>';
      });
  }

  function loadCatalog() {
    els.retry.hidden = true;
    els.grid.innerHTML = '<div class="loading">正在读取在线插件目录…</div>';
    els.summaryState.textContent = '正在读取目录';
    els.install.disabled = true;
    api('/api/catalog')
      .then(function (catalog) {
        state.catalog = catalog;
        state.selected = new Set(
          (catalog.plugins || []).map(function (item) {
            return item.id;
          })
        );
        els.summaryState.textContent = '已连接';
        renderPlugins();
      })
      .catch(function (error) {
        state.catalog = null;
        els.grid.innerHTML =
          '<div class="empty">' +
          esc(error.message || '无法读取在线目录') +
          '<br><br>请检查网络，或稍后重试。</div>';
        els.summaryState.textContent = '目录不可用';
        els.retry.hidden = false;
        els.install.disabled = true;
      });
  }

  function renderPlugins() {
    if (!state.catalog) return;
    var items = state.catalog.plugins || [];
    if (!items.length) {
      els.grid.innerHTML = '<div class="empty">在线目录暂时没有插件。</div>';
    } else {
      els.grid.innerHTML = items
        .map(function (item) {
          var checked = state.selected.has(item.id);
          return (
            '<label class="plugin ' +
            (checked ? 'checked' : '') +
            '" data-id="' +
            esc(item.id) +
            '">' +
            '<input type="checkbox" ' +
            (checked ? 'checked' : '') +
            ' />' +
            '<span class="glyph">' +
            esc(item.glyph || '?') +
            '</span>' +
            '<span class="meta"><span class="name">' +
            esc(item.name) +
            '<span class="version">' +
            esc(item.version || '') +
            '</span></span><span class="desc">' +
            esc(item.description || '') +
            '</span></span>' +
            '<span class="size">' +
            bytes(item.size) +
            '</span>' +
            '<span class="checkmark">' +
            (checked ? '✓' : '') +
            '</span></label>'
          );
        })
        .join('');
      Array.prototype.forEach.call(
        els.grid.querySelectorAll('.plugin'),
        function (el) {
          el.addEventListener('click', function (event) {
            event.preventDefault();
            var id = el.dataset.id;
            if (state.selected.has(id)) state.selected.delete(id);
            else state.selected.add(id);
            renderPlugins();
          });
        }
      );
    }
    updateSummary();
  }

  function updateSummary() {
    if (!state.catalog) return;
    var chosen = (state.catalog.plugins || []).filter(function (item) {
      return state.selected.has(item.id);
    });
    var size = chosen.reduce(function (sum, item) {
      return sum + (Number(item.size) || 0);
    }, 0);
    els.summaryCount.textContent = String(chosen.length);
    els.summarySize.textContent = bytes(size);
    els.railCount.textContent = String(chosen.length);
    els.railSize.textContent = bytes(size);
    els.install.disabled = state.installing || !state.catalog;
    els.install.textContent = state.installing ? '安装中…' : '开始安装';
  }

  function loadAppearance() {
    try {
      var raw = localStorage.getItem(APPEARANCE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          appearance.radius = [0, 4, 8, 12, 16].indexOf(Number(data.radius)) >= 0 ? Number(data.radius) : 0;
          appearance.accent = ['amber', 'olive', 'rust', 'blue'].indexOf(data.accent) >= 0 ? data.accent : 'amber';
          appearance.motion = data.motion !== false;
          appearance.compact = !!data.compact;
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  function saveAppearance() {
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
    } catch (e) {
      /* ignore */
    }
  }

  function applyAppearance() {
    document.documentElement.style.setProperty('--radius', appearance.radius + 'px');
    document.documentElement.dataset.accent = appearance.accent;
    document.body.classList.toggle('no-motion', !appearance.motion);
    document.body.classList.toggle('compact', appearance.compact);
    Array.prototype.forEach.call(document.querySelectorAll('[data-radius]'), function (btn) {
      btn.classList.toggle('active', Number(btn.dataset.radius) === appearance.radius);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-accent]'), function (btn) {
      btn.classList.toggle('active', btn.dataset.accent === appearance.accent);
    });
    var motion = document.getElementById('motion');
    var compact = document.getElementById('compact');
    if (motion) motion.setAttribute('aria-checked', String(appearance.motion));
    if (compact) compact.setAttribute('aria-checked', String(appearance.compact));
  }

  function bindSettings() {
    function open() {
      els.settings.hidden = false;
    }
    function close() {
      els.settings.hidden = true;
    }
    ['settings-open', 'settings-open-2'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', open);
    });
    document.getElementById('settings-close').addEventListener('click', close);
    document.getElementById('settings-done').addEventListener('click', close);
    els.settings.addEventListener('click', function (event) {
      if (event.target === els.settings) close();
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-radius]'), function (btn) {
      btn.addEventListener('click', function () {
        appearance.radius = Number(btn.dataset.radius);
        saveAppearance();
        applyAppearance();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-accent]'), function (btn) {
      btn.addEventListener('click', function () {
        appearance.accent = btn.dataset.accent;
        saveAppearance();
        applyAppearance();
      });
    });
    document.getElementById('motion').addEventListener('click', function () {
      appearance.motion = !appearance.motion;
      saveAppearance();
      applyAppearance();
    });
    document.getElementById('compact').addEventListener('click', function () {
      appearance.compact = !appearance.compact;
      saveAppearance();
      applyAppearance();
    });
    document.getElementById('settings-reset').addEventListener('click', function () {
      appearance = { radius: 0, accent: 'amber', motion: true, compact: false };
      saveAppearance();
      applyAppearance();
    });
  }

  function browse() {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.choose_folder) {
      window.pywebview.api.choose_folder(els.dir.value).then(function (path) {
        if (path) els.dir.value = path;
      });
    }
  }

  function startInstall() {
    if (state.installing || !state.catalog) return;
    var directory = els.dir.value.trim();
    if (!directory) {
      els.dir.focus();
      return;
    }
    state.installing = true;
    els.progressPanel.hidden = false;
    els.progressLog.textContent = '';
    els.progressBar.style.width = '0%';
    els.progressPercent.textContent = '0%';
    els.progressMessage.textContent = '正在准备…';
    els.summaryState.textContent = '安装中';
    updateSummary();
    api('/api/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plugins: Array.from(state.selected),
        directory: directory,
        shortcut: els.shortcut.checked,
      }),
    })
      .then(function () {
        pollProgress();
      })
      .catch(function (error) {
        state.installing = false;
        els.progressMessage.textContent = error.message;
        els.summaryState.textContent = '安装失败';
        updateSummary();
      });
  }

  function pollProgress() {
    window.clearTimeout(state.poll);
    api('/api/progress')
      .then(function (progress) {
        els.progressMessage.textContent = progress.message || '';
        els.progressPercent.textContent = (progress.percent || 0) + '%';
        els.progressBar.style.width = (progress.percent || 0) + '%';
        els.progressLog.textContent = (progress.logs || []).join('\n');
        els.progressLog.scrollTop = els.progressLog.scrollHeight;
        if (progress.done) {
          state.installing = false;
          els.summaryState.textContent = '安装完成';
          els.install.textContent = '重新安装';
          els.install.disabled = false;
          els.done.hidden = false;
          return;
        }
        if (progress.error) {
          state.installing = false;
          els.summaryState.textContent = '安装失败';
          els.progressMessage.textContent = progress.error;
          els.install.textContent = '重试安装';
          els.install.disabled = false;
          return;
        }
        if (progress.running) {
          state.poll = window.setTimeout(pollProgress, 500);
        }
      })
      .catch(function (error) {
        state.installing = false;
        els.progressMessage.textContent = error.message;
        els.summaryState.textContent = '状态读取失败';
        updateSummary();
      });
  }

  function launch() {
    api('/api/launch', { method: 'POST', body: '{}' })
      .then(function () {
        els.done.hidden = true;
        els.summaryState.textContent = '已启动';
      })
      .catch(function (error) {
        els.progressMessage.textContent = error.message;
      });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
