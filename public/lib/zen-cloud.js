/* OMM-ZEN lib · cloud sync
 * ------------------------------------------------------------------
 * Shared Supabase cloud-sync panel and the product-independent part of the
 * sync engine. Product pages keep only their own data snapshot/normalisation
 * and conflict-resolution policy; everything else (panel markup, preferences,
 * warning acknowledgement, watcher timers, remote read, error labels) has one
 * implementation here.
 *
 * Exposes: window.ZenCloud
 * Depends: zen/foundation/util.js, zen/components/dialog.js, features/cloud.css
 */
;(function (global) {
  'use strict'
  var cloud = (global.ZenCloud = global.ZenCloud || {})
  var esc = global.ZenUtil.esc

  /* ---------------------------------------------------------- panel markup */
  function panelHTML(c) {
    var p = c.prefix || 'zp'
    var L = c.labels || {}
    var i18n = c.i18n
      ? function (key) { return key ? ' data-i18n="' + esc(key) + '"' : '' }
      : function () { return '' }
    var ip = c.i18n
      ? function (key) { return key ? ' data-i18n-placeholder="' + esc(key) + '"' : '' }
      : function () { return '' }
    var text = function (value, key) { return esc(L[key] == null ? value : L[key]) }
    var sql = c.sql ? esc(c.sql) : ''
    return [
      '<div class="zen-cloud-status" id="zen-cloud-status"' + i18n('sync.notConfigured') + '>' + text('未配置 Supabase', 'notConfigured') + '</div>',
      '<div id="' + p + '-config-panel">',
      '<div class="zen-cloud-field"><div class="zen-cloud-label"' + i18n('sync.projectUrl') + '>' + text('Project URL', 'projectUrl') + '</div>',
      '<input class="zen-cloud-input" id="' + p + '-sb-url" type="url" autocomplete="off" spellcheck="false"' + ip('sync.urlPlaceholder') + ' placeholder="https://xxxx.supabase.co" /></div>',
      '<div class="zen-cloud-field"><div class="zen-cloud-label"' + i18n('sync.publishableKey') + '>' + text('Publishable Key', 'publishableKey') + '</div>',
      '<input class="zen-cloud-input" id="' + p + '-sb-key" type="text" autocomplete="off" spellcheck="false"' + ip('sync.keyPlaceholder') + ' placeholder="sb_publishable_..." />',
      '<div class="zen-cloud-help"' + i18n('sync.keyHelp') + '>' + text('只填 Supabase Publishable key，不要把 service_role / secret key 放进页面', 'keyHelp') + '</div></div>',
      '<div class="zen-cloud-field"><div class="zen-cloud-label"' + i18n('sync.authEmail') + '>' + text('Auth 邮箱', 'authEmail') + '</div>',
      '<input class="zen-cloud-input" id="' + p + '-auth-email-config" type="email" autocomplete="off" spellcheck="false"' + ip('sync.emailPlaceholder') + ' placeholder="your@email.com" />',
      '<div class="zen-cloud-help"' + i18n('sync.authEmailHelp') + '>' + text('只保存邮箱地址用于登录；密码仅在勾选“记住密码”后保存到本机', 'authEmailHelp') + '</div></div>',
      '<div class="zen-cloud-note"><strong' + i18n('sync.accountGuideTitle') + '>' + text('账号与密码', 'accountGuideTitle') + '</strong><br /><span' + i18n('sync.accountGuide') + '>' + text('请先登录 Supabase Dashboard，在 Authentication → Users 中创建一个 Auth 用户，然后使用该用户的邮箱和密码登录本应用', 'accountGuide') + '</span></div>',
      '<div class="zen-cloud-actions"><button class="zen-cloud-btn primary" id="' + p + '-save-config" type="button"' + i18n('sync.saveConfig') + '>' + text('保存连接设置', 'saveConfig') + '</button>',
      '<button class="zen-cloud-btn" id="' + p + '-open-dashboard" type="button"' + i18n('sync.openDashboard') + '>' + text('打开 Supabase Dashboard', 'openDashboard') + '</button></div>',
      '<div class="zen-cloud-actions"><button class="zen-cloud-btn" id="' + p + '-open-sql" type="button"' + i18n('sync.viewSql') + '>' + text('查看建表 SQL', 'viewSql') + '</button></div></div>',
      '<div id="' + p + '-auth-panel" class="zen-cloud-hidden">',
      '<div class="zen-cloud-note"><strong' + i18n('sync.loginGuideTitle') + '>' + text('登录与同步', 'loginGuideTitle') + '</strong><br /><span' + i18n('sync.loginGuide') + '>' + text('登录时无需再次输入账号，账号邮箱来自连接设置，下面只需要输入密码', 'loginGuide') + '</span></div>',
      '<div class="zen-cloud-field"><div class="zen-cloud-label"' + i18n('sync.password') + '>' + text('密码', 'password') + '</div>',
      '<input class="zen-cloud-input" id="' + p + '-password" type="password" autocomplete="current-password" spellcheck="false"' + ip('sync.passwordPlaceholder') + ' placeholder="Supabase 登录密码" />',
      '<div class="zen-cloud-help"' + i18n('sync.passwordHelp') + '>' + text('密码用于 Supabase Auth 验证和客户端 AES 解密。勾选“记住密码”后只存在本机浏览器的 LocalStorage 里，不会上传到云端', 'passwordHelp') + '</div>',
      '<label class="zen-remember" for="' + p + '-remember-pw"><input type="checkbox" id="' + p + '-remember-pw" />',
      '<span class="zen-cbox" aria-hidden="true"><svg viewBox="0 0 12 12"><polyline points="1.6,6.4 4.4,9.2 10.4,2.9" /></svg></span>',
      '<span' + i18n('sync.rememberPw') + '>' + text('记住密码（下次打开页面自动登录，无需再次输入）', 'rememberPw') + '</span></label></div>',
      '<div class="zen-autosync"><div class="zen-autosync-main"><div class="zen-autosync-title"' + i18n('sync.syncStrategy') + '>' + text('同步策略', 'syncStrategy') + '</div>',
      '<div class="zen-autosync-desc" id="zen-autosync-desc"></div></div>',
      '<button class="zen-autosync-btn" id="zen-autosync-btn" type="button" aria-pressed="false">',
      '<span class="zen-as-dot"></span><span id="' + p + '-autosync-text"></span></button></div>',
      '<div class="zen-cloud-actions zen-cloud-actions-3">',
      '<button class="zen-cloud-btn primary" id="' + p + '-login-only" type="button"' + i18n('sync.loginOnly') + '>' + text('登录', 'loginOnly') + '</button>',
      '<button class="zen-cloud-btn" id="' + p + '-login-pull" type="button"' + i18n('sync.loginAndPull') + '>' + text('登录并从云端同步', 'loginAndPull') + '</button>',
      '<button class="zen-cloud-btn" id="' + p + '-login-push" type="button"' + i18n('sync.loginAndPush') + '>' + text('登录并上传本地', 'loginAndPush') + '</button></div>',
      '<div class="zen-cloud-actions">',
      '<button class="zen-cloud-btn" id="' + p + '-open-sql-auth" type="button"' + i18n('sync.viewSql') + '>' + text('查看建表 SQL', 'viewSql') + '</button>',
      '<button class="zen-cloud-btn danger" id="' + p + '-signout" type="button"' + i18n('sync.signOut') + '>' + text('退出登录', 'signOut') + '</button></div>',
      '<div class="zen-cloud-actions zen-cloud-hidden" id="' + p + '-sync-actions">',
      '<button class="zen-cloud-btn" id="' + p + '-sync-now" type="button"' + i18n('sync.syncNow') + '>' + text('从云端同步', 'syncNow') + '</button>',
      '<button class="zen-cloud-btn" id="' + p + '-upload-now" type="button"' + i18n('sync.uploadNow') + '>' + text('上传本地', 'uploadNow') + '</button>',
      '<button class="zen-cloud-btn" id="' + p + '-lock" type="button"' + i18n('sync.lock') + '>' + text('锁定数据', 'lock') + '</button></div></div>',
      '<div class="zen-cloud-hidden" id="' + p + '-sql-panel">',
      '<div class="zen-cloud-label" style="margin-bottom: 6px"' + i18n('sync.sqlEditor') + '>' + text('SQL 编辑器', 'sqlEditor') + '</div>',
      '<textarea id="zen-sql-box" readonly spellcheck="false">' + sql + '</textarea>',
      '<div class="zen-cloud-actions"><button class="zen-cloud-btn primary" id="' + p + '-copy-sql" type="button"' + i18n('sync.copySql') + '>' + text('复制 SQL', 'copySql') + '</button>',
      '<button class="zen-cloud-btn" id="' + p + '-back-config" type="button"' + i18n('sync.backConfig') + '>' + text('返回设置', 'backConfig') + '</button></div>',
      '<div class="zen-cloud-copy-status" id="' + p + '-sql-copy-status" aria-live="polite"></div></div>',
    ].join('')
  }

  function footHTML(c) {
    var L = c.labels || {}
    var content = L.footer == null
      ? 'Supabase Auth 负责身份验证，RLS 负责用户隔离；数据上传前在浏览器端使用 AES-GCM 加密。应用只使用 Publishable key。'
      : esc(L.footer)
    return c.i18n
      ? '<span data-i18n="sync.footer">' + content + '</span>'
      : content
  }

  function warnHTML(c) {
    var p = c.prefix || 'zp'
    var L = c.labels || {}
    var body = L.warnBody == null
      ? '开启后，本页的任何改动都会立刻写入云端并覆盖此前保存的云端数据。<br />云端不会保留任何历史记录的备份，误删除、误改动都无法回滚，并且会立刻影响到所有登录同一账号的设备。'
      : L.warnBody
    var attr = c.i18n ? ' data-i18n="sync.warnBody"' : ''
    return '<div class="zen-warn-body" id="zen-warn-body"' + attr + '>' + body + '</div>' +
      '<div class="zen-warn-actions">' +
      '<button class="zen-cloud-btn" id="' + p + '-warn-cancel" type="button"' +
      (c.i18n ? ' data-i18n="sync.warnCancel"' : '') + '>' + esc(L.warnCancel || '取消') + '</button>' +
      '<button class="zen-cloud-btn primary" id="' + p + '-warn-ok" type="button"' +
      (c.i18n ? ' data-i18n="sync.warnOk"' : '') + '>' + esc(L.warnOk || '我已了解，开启') + '</button></div>'
  }

  cloud.panelHTML = panelHTML
  cloud.footHTML = footHTML
  cloud.warnHTML = warnHTML

  /* ---------------------------------------------------------- engine core */
  function create(c) {
    var cfgKey = c.cfgKey
    var metaKey = c.metaKey
    var warnHandle = null
    var api = {}

    api.cfg = function () { return ZenUtil.getJSON(cfgKey, {}) }
    api.meta = function () { return ZenUtil.getJSON(metaKey, {}) }
    api.patchCfg = function (part) {
      var cfg = api.cfg()
      Object.keys(part || {}).forEach(function (k) {
        if (part[k] === undefined) delete cfg[k]
        else cfg[k] = part[k]
      })
      try { localStorage.setItem(cfgKey, JSON.stringify(cfg)) } catch (_) {}
      return api.cfg()
    }
    api.prefs = function () {
      var cfg = api.cfg()
      return {
        remember: !!cfg.remember,
        autoSync: !!cfg.autoSync,
        warnAck: !!cfg.warnAck,
        password: typeof cfg.password === 'string' ? cfg.password : '',
      }
    }
    api.savePrefs = function (next) {
      var p = api.prefs()
      return api.patchCfg({
        remember: next.remember !== undefined ? !!next.remember : p.remember,
        autoSync: next.autoSync !== undefined ? !!next.autoSync : p.autoSync,
        warnAck: next.warnAck !== undefined ? !!next.warnAck : p.warnAck,
        password: next.remember ? (next.password !== undefined ? next.password : p.password) : undefined,
      })
    }
    api.openWarn = function (onOk, onCancel) {
      var confirmed = false
      warnHandle = global.ZenUI.modal.open({
        title: typeof c.warnTitle === 'function' ? c.warnTitle() : (c.warnTitle || '开启云同步前请注意'),
        width: 'min(400px, 92vw)',
        html: warnHTML(c),
        ids: { title: 'zen-warn-title' },
        onMount: function (body) {
          var ok = body.querySelector('#' + (c.prefix || 'zp') + '-warn-ok')
          var cc = body.querySelector('#' + (c.prefix || 'zp') + '-warn-cancel')
          if (cc) cc.addEventListener('click', function () { global.ZenUI.modal.close() })
          if (ok) ok.addEventListener('click', function () {
            confirmed = true
            global.ZenUI.modal.close()
            if (onOk) onOk()
          })
          if (c.onWarnMount) c.onWarnMount(body)
          setTimeout(function () { try { if (ok) ok.focus() } catch (_) {} }, 30)
        },
        onClose: function () {
          warnHandle = null
          if (!confirmed && onCancel) onCancel()
        },
      })
      return warnHandle
    }
    api.warnHandle = function () { return warnHandle }
    api.ensureWarnAck = function () {
      return new Promise(function (ok) {
        var p = api.prefs()
        if (!p.autoSync || p.warnAck) return ok(true)
        api.openWarn(function () { api.savePrefs({ warnAck: true }); ok(true) }, function () { ok(false) })
      })
    }
    api.now = function () { return Date.now() }
    api.remote = function () {
      var client = c.client()
      if (!client || !c.session()) return Promise.resolve(null)
      return client.from(c.table)
        .select('payload,client_updated_at')
        .eq('user_id', c.session().user.id)
        .maybeSingle()
    }
    api.closeModal = function () { global.ZenUI.modal.close() }
    api.setStatusText = function (v) {
      var e = document.getElementById(c.statusId || 'zen-cloud-status')
      if (e) e.textContent = v
    }
    api.isTableMissing = function (err) {
      return global.ZenUtil.isTableMissing(err)
    }
    api.friendly = function (err) {
      var t = c.t || function (key, fallback) { return fallback == null ? key : fallback }
      var m = (((err && err.name && err.name !== 'Error' ? err.name + ' ' : '') +
        ((err && err.message) || '')).trim()) || String(err || '')
      if (api.isTableMissing(err)) return t('sync.tableMissing', '云同步表尚未创建，请先执行建表 SQL')
      if (/Invalid login credentials/i.test(m)) return t('sync.invalidLogin', '邮箱或密码不正确')
      if (/Email not confirmed/i.test(m)) return t('sync.emailNotConfirmed', '邮箱尚未确认')
      if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return t('sync.networkFailed', '网络请求失败')
      if (/decrypt|OperationError|InvalidStateError|Unexpected token|is not valid JSON/i.test(m)) {
        return t('sync.decryptFailed', '云端数据解密失败，请确认密码正确')
      }
      if (/localStorage|QuotaExceeded|存储/i.test(m)) return t('sync.storageFailed', '本机存储写入失败')
      return /^\[object /.test(m) ? t('sync.unknownError', '操作失败，请重试') : (m || t('sync.unknownError', '操作失败'))
    }
    return api
  }
  cloud.create = create
})(window)
