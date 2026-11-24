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
  var appearance = { motion: true, compact: false };
  var doneModal = null;
  var els = {};

  var esc = ZenUtil.esc;

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
    els.shortcut = document.getElementById('shortcut');
    els.railCount = document.getElementById('rail-count');
    els.railSize = document.getElementById('rail-size');

    loadAppearance();
    applyAppearance();
    bindSettings();

    els.grid.addEventListener('change', function (event) {
      var input = event.target.closest('.plugin input[type="checkbox"]');
      if (!input) return;
      var item = input.closest('.plugin[data-id]');
      if (!item) return;
      if (input.checked) state.selected.add(item.dataset.id);
      else state.selected.delete(item.dataset.id);
      syncPluginSelection();
    });
    document.getElementById('select-all').addEventListener('click', function () {
      if (!state.catalog) return;
      state.catalog.plugins.forEach(function (item) {
        state.selected.add(item.id);
      });
      syncPluginSelection();
    });
    document.getElementById('select-none').addEventListener('click', function () {
      state.selected.clear();
      syncPluginSelection();
    });
    document.getElementById('browse').addEventListener('click', browse);
    els.install.addEventListener('click', startInstall);
    els.retry.addEventListener('click', loadCatalog);

    loadConfig()
      .then(loadCatalog)
      .catch(function (error) {
        // 配置接口失败时不能被目录接口“正在读取…”覆盖，否则用户只看到
        // 一个无意义的“目录不可用”，无法发现安装目录从未加载成功。
        els.summaryState.textContent = '配置加载失败';
        els.install.disabled = true;
        els.grid.innerHTML = '<div class="empty">安装配置加载失败：' + esc(error.message) + '</div>';
      });
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
        els.pluginDir.textContent = els.pluginDir.textContent || '—';
        throw error;
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
            '<span class="glyph' +
            (window.OMMIconClass ? window.OMMIconClass(item.id) : '') +
            '">' +
            (window.OMMIcon ? window.OMMIcon(item.id, item.glyph) : esc(item.glyph || '?')) +
            '</span>' +
            '<span class="meta"><span class="name">' +
            esc(item.name) +
            '<span class="version">' +
            esc(item.version || '') +
            '</span></span><span class="desc">' +
            esc(item.description || '') +
            '</span></span>' +
            '<span class="size">' +
            ZenUtil.formatBytes(item.size) +
            '</span>' +
            '<span class="checkmark">' +
            (checked ? '✓' : '') +
            '</span></label>'
          );
        })
        .join('');
    }
    updateSummary();
  }

  function syncPluginSelection() {
    Array.prototype.forEach.call(els.grid.querySelectorAll('.plugin[data-id]'), function (item) {
      var checked = state.selected.has(item.dataset.id);
      item.classList.toggle('checked', checked);
      var input = item.querySelector('input[type="checkbox"]');
      if (input) input.checked = checked;
      var mark = item.querySelector('.checkmark');
      if (mark) mark.textContent = checked ? '✓' : '';
    });
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
    els.summarySize.textContent = ZenUtil.formatBytes(size);
    els.railCount.textContent = String(chosen.length);
    els.railSize.textContent = ZenUtil.formatBytes(size);
    els.install.disabled = state.installing || !state.catalog;
    els.install.textContent = state.installing ? '安装中…' : '开始安装';
  }

  function loadAppearance() {
    var data = ZenUtil.getJSON(APPEARANCE_KEY, {}) || {};
    appearance.motion = data.motion !== false;
    appearance.compact = !!data.compact;
    // 旧版本可能在同一对象里存过 radius；立即用规范对象覆盖，删除旧持久化。
    if (Object.prototype.hasOwnProperty.call(data, 'radius')) saveAppearance();
  }

  function saveAppearance() {
    ZenUtil.setJSON(APPEARANCE_KEY, appearance);
  }

  function applyAppearance() {
    document.body.classList.toggle('no-motion', !appearance.motion);
    document.body.classList.toggle('compact', appearance.compact);
    var motion = document.getElementById('motion');
    var compact = document.getElementById('compact');
    if (motion) motion.setAttribute('aria-checked', String(appearance.motion));
    if (compact) compact.setAttribute('aria-checked', String(appearance.compact));
  }

  var SETTINGS_HTML =
    '<div class="settings-body">' +
      '<div class="settings-sub">只影响安装器界面，不影响已安装产品</div>' +
      '<section class="setting">' +
        '<div class="setting-label">界面动效</div>' +
        '<button class="switch" data-zen-switch id="motion" type="button" role="switch" aria-checked="true">' +
          '<span class="switch-track"></span><span>启用过渡与进度动画</span>' +
        '</button>' +
      '</section>' +
      '<section class="setting">' +
        '<div class="setting-label">紧凑布局</div>' +
        '<button class="switch" data-zen-switch id="compact" type="button" role="switch" aria-checked="false">' +
          '<span class="switch-track"></span><span>缩小间距，在一屏内看到更多产品</span>' +
        '</button>' +
      '</section>' +
    '</div>';
  var SETTINGS_FOOT =
    '<button class="ghost" id="settings-reset" type="button">恢复默认</button>' +
    '<button class="primary" id="settings-done" type="button">完成</button>';

  function bindSettings() {
    function open() {
      if (window.ZenUI && window.ZenUI.modal.isOpen()) return;
      window.ZenUI.modal.open({
        title: '外观设置',
        html: SETTINGS_HTML,
        foot: SETTINGS_FOOT,
        width: 'min(460px, calc(100vw - 28px))',
        onMount: function () {
          applyAppearance();
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
            appearance = { motion: true, compact: false };
            saveAppearance();
            applyAppearance();
          });
          document.getElementById('settings-done').addEventListener('click', function () {
            window.ZenUI.modal.close();
          });
        },
      });
    }
    ['settings-open', 'settings-open-2'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', open);
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
          showDone();
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

  function showDone() {
    if (doneModal) return;
    var template = document.getElementById('done-tpl');
    doneModal = window.ZenUI.modal.open({
      title: '安装完成',
      html: template ? template.innerHTML : '',
      width: 'min(440px, calc(100vw - 28px))',
      onMount: function () {
        document.getElementById('launch').addEventListener('click', launch);
        document.getElementById('close-done').addEventListener('click', function () {
          if (doneModal) doneModal.close();
        });
      },
      onClose: function () { doneModal = null; },
    });
  }

  function launch() {
    var button = document.getElementById('launch');
    var error = document.getElementById('launch-error');
    button.disabled = true;
    button.textContent = '正在启动…';
    error.hidden = true;
    api('/api/launch', { method: 'POST', body: '{}' })
      .then(function () {
        els.summaryState.textContent = '已启动';
        if (doneModal) doneModal.close();
      })
      .catch(function (failure) {
        button.disabled = false;
        button.textContent = '启动 静书房';
        error.textContent = '启动失败：' + failure.message;
        error.hidden = false;
        els.summaryState.textContent = '启动失败';
        button.focus();
      });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
