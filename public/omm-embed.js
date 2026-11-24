/* OMM-ZEN boot bridge.
 *
 * Loaded by every omm-*.html page. It removes the branded splash screen from
 * both standalone builds and the hub: the page enters its normal working state
 * immediately, using the product's original enter handler.
 *
 * Inside the hub (?omm_embed=1) it also forwards hub-level shortcuts
 * (Ctrl+Tab, Ctrl+W, Ctrl+1..9, ...) to the shell with postMessage.
 */
(function () {
  'use strict';

  var embedded = false;
  try {
    embedded = new URLSearchParams(window.location.search).get('omm_embed') === '1';
  } catch (e) {
    embedded = /[?&]omm_embed=1(?:&|$)/.test(window.location.search);
  }

  if (embedded) document.documentElement.classList.add('omm-embed');

  /* The hub passes its real origin in the iframe URL. ZenUtil owns both target
     origin resolution and inbound trust so the bridges cannot drift apart. */
  function parentTargetOrigin() {
    return window.ZenUtil ? window.ZenUtil.parentTargetOrigin() : location.origin;
  }

  function post(action, extra) {
    var msg = { type: 'omm:shortcut', action: action };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) msg[key] = extra[key];
      }
    }
    try {
      window.parent.postMessage(msg, parentTargetOrigin());
    } catch (e) {
      /* ignore */
    }
  }

  if (embedded) {
    /* A click inside a product pane belongs to another document, so the hub
       cannot hear it.  Forward it and let the shell close its popovers. */
    document.addEventListener(
      'pointerdown',
      function () {
        try {
          window.parent.postMessage({ type: 'omm:pointerdown' }, parentTargetOrigin());
        } catch (e) {
          /* ignore */
        }
      },
      true
    );

    /* The hub can ask this product to take a shared document.  The desktop
       bridge may still be booting, so a request that arrives too early is
       queued until `omm-desktop-ready` instead of being dropped. */
    var pendingFile = null;
    function takeFile(data) {
      if (!window.OMMDesktop || !window.OMMDesktop.loadResource) {
        pendingFile = data;
        return;
      }
      window.OMMDesktop.loadResource({
        path: data.path,
        name: data.name,
        mime: data.mime,
      });
    }
    /* 工作台广播的主题/缩放统一落到 zen 令牌；ZEN 界面圆角固定为直角。 */
    function applyZenTheme(data) {
      if (!data) return;
      var root = document.documentElement;
      var dark = data.theme === 'dark';
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
      document.body.classList.toggle('theme-dark', dark);
      var map = {
        '--zen-radius': '0px',
        '--zen-fscale': data.scale == null ? null : String(data.scale)
      };
      Object.keys(map).forEach(function (key) {
        if (map[key] == null) return;
        root.style.setProperty(key, String(map[key]));
      });
      root.style.setProperty('--radius', '0px');
    }

    window.addEventListener('message', function (event) {
      if (!window.ZenUtil || !window.ZenUtil.isTrustedParentMessage(event)) return;
      var data = event.data;
      if (!data) return;
      if (data.type === 'omm:theme') {
        applyZenTheme(data);
        return;
      }
      if (data.type !== 'omm:load-file') return;
      takeFile(data);
    });
    window.addEventListener('omm-desktop-ready', function () {
      if (!pendingFile) return;
      var data = pendingFile;
      pendingFile = null;
      takeFile(data);
    });

    window.addEventListener(
      'keydown',
      function (event) {
        if (window.ZenUI && window.ZenUI.layer && window.ZenUI.layer.hasOpen()) return;
        var mod = event.ctrlKey || event.metaKey;
        if (!mod) return;
        var key = event.key;
        var lower = (key || '').toLowerCase();
        var action = null;
        var extra = null;

        if (key === 'Tab') {
          action = event.shiftKey ? 'prev-tab' : 'next-tab';
        } else if (lower === 'w') {
          action = 'close-tab';
        } else if (lower === 'k') {
          action = 'command-palette';
        } else if (lower === 't' && event.shiftKey) {
          action = 'reopen-tab';
        } else if (lower === 'n' && event.shiftKey) {
          action = 'notify-panel';
        } else if (key === '\\' || key === '|') {
          action = event.shiftKey ? 'split-h' : 'split-v';
        } else if (lower === 'd' && event.shiftKey) {
          action = 'toggle-dock';
        } else if (lower === 'm' && event.shiftKey) {
          action = 'focus-pane';
        } else if (/^[0-9]$/.test(key)) {
          action = 'open-index';
          extra = { index: key === '0' ? 0 : parseInt(key, 10) };
        }

        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        post(action, extra);
      },
      true
    );
  }

  function enterApp() {
    var splash = document.getElementById('splash');
    if (!splash) return true;
    var cls = ' ' + (splash.className || '') + ' ';
    var done =
      cls.indexOf(' fade-out ') >= 0 ||
      cls.indexOf(' splash-hide ') >= 0 ||
      splash.style.display === 'none';
    if (done) return true;
    var button =
      splash.querySelector('.splash-enter') ||
      document.getElementById('splash-enter');
    if (button) {
      try {
        button.click();
      } catch (e) {
        /* ignore */
      }
    }
    return false;
  }

  function boot() {
    enterApp();
    /* Some pages bind their enter handler after DOMContentLoaded. Retry once
     * after a short delay, but never when the page already started fading. */
    window.setTimeout(function () {
      if (enterApp()) return;
      window.setTimeout(function () {
        if (enterApp()) return;
        var splash = document.getElementById('splash');
        if (splash) splash.style.display = 'none';
      }, 900);
    }, 450);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
