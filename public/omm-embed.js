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

  /* Hide the splash before first paint; the enter handler still runs below. */
  var style = document.createElement('style');
  style.id = 'omm-embed-style';
  style.textContent = '#splash{display:none!important}';
  (document.head || document.documentElement).appendChild(style);

  function post(action, extra) {
    var msg = { type: 'omm:shortcut', action: action };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) msg[key] = extra[key];
      }
    }
    try {
      window.parent.postMessage(msg, '*');
    } catch (e) {
      /* ignore */
    }
  }

  if (embedded) {
    window.addEventListener(
      'keydown',
      function (event) {
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
