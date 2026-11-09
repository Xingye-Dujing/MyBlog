/* Product marks.
 *
 * Dedicated product icons (currently writer's icon-writer.png) are shown
 * without a frame. Other products use the temporary coloured SVG marks until
 * their icon-<id>.png is ready; add it to `dedicated` to switch.
 */
(function () {
  'use strict';

  var INK = '#26231f';
  var AMBER = '#e3a400';
  var OLIVE = '#7c7f42';
  var RUST = '#b56545';
  var BLUE = '#5b7692';
  var TEAL = '#4f8a8b';
  var PLUM = '#8a5a7a';
  var GREEN = '#5f8a5a';

  var dedicated = {
    writer: 'icon-writer.png',
  };

  var icons = {
    annotate:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h9l4 4v13H5z" fill="#ffffff" stroke="' + INK + '"/><path d="M14 3.5v4h4" fill="none" stroke="' + INK + '"/><path d="M8 11h6M8 14h6" fill="none" stroke="' + INK + '"/><path d="M12.5 19l5-5 2 2-5 5-2.5.5z" fill="' + AMBER + '" stroke="' + INK + '"/></svg>',
    corpus:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5c3-1.2 6-.8 9 1.2v14.6C9 18.8 6 18.4 3 19.6z" fill="#e7f1ef" stroke="' + INK + '"/><path d="M21 5c-3-1.2-6-.8-9 1.2v14.6c3-1.8 6-2.2 9-1z" fill="#d7e9e5" stroke="' + INK + '"/><path d="M12 6.2v14.6" fill="none" stroke="' + TEAL + '" stroke-width="1.8"/></svg>',
    data:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" fill="#ffffff" stroke="' + INK + '"/><path d="M3 4h18v5H3z" fill="' + AMBER + '" stroke="' + INK + '"/><path d="M3 9v11M9 9v11M15 9v11" fill="none" stroke="' + INK + '"/><rect x="9" y="14" width="6" height="6" fill="#e8f0e4" stroke="none"/></svg>',
    english:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9l10-5 10 5-10 5z" fill="' + AMBER + '" stroke="' + INK + '"/><path d="M6 11v5c0 2.2 2.7 4 6 4s6-1.8 6-4v-5" fill="#eef1f7" stroke="' + INK + '"/><path d="M22 9v6" fill="none" stroke="' + BLUE + '" stroke-width="1.8"/></svg>',
    latex:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5z" fill="#fff7ef" stroke="' + INK + '"/><path d="M15 3v4h4" fill="none" stroke="' + INK + '"/><path d="M8 7h8M12 7v9M9 16h6" fill="none" stroke="' + RUST + '" stroke-width="2"/></svg>',
    mdforge:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5z" fill="#f4eef7" stroke="' + INK + '"/><path d="M15 3v4h4" fill="none" stroke="' + INK + '"/><path d="M8 16v-5l2 3 2-3v5" fill="none" stroke="' + PLUM + '" stroke-width="2"/><path d="M16 11v5M14 14l2 2 2-2" fill="none" stroke="' + AMBER + '" stroke-width="2"/></svg>',
    message:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h12v8H8l-5 3z" fill="#dcebf2" stroke="' + BLUE + '"/><path d="M9 15h9v5l-4-2H9z" fill="' + AMBER + '" stroke="' + INK + '"/><path d="M7 8h4" fill="none" stroke="' + BLUE + '"/></svg>',
    planner:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" fill="#ffffff" stroke="' + INK + '"/><path d="M3 5h18v4H3z" fill="' + RUST + '" stroke="' + INK + '"/><path d="M8 3v4M16 3v4" fill="none" stroke="' + INK + '"/><path d="M8 15l2 2 5-5" fill="none" stroke="' + GREEN + '" stroke-width="2"/></svg>',
    redact:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5z" fill="#ffffff" stroke="' + INK + '"/><path d="M15 3v4h4" fill="none" stroke="' + INK + '"/><path d="M8 12h8M8 16h8" fill="none" stroke="' + INK + '"/><rect x="7" y="10.5" width="10" height="3" fill="#c05a4a" stroke="' + INK + '"/></svg>',
    visualization:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3v18h17" fill="none" stroke="' + INK + '"/><rect x="7" y="12" width="3" height="6" fill="' + AMBER + '"/><rect x="12" y="8" width="3" height="10" fill="' + OLIVE + '"/><rect x="17" y="5" width="3" height="13" fill="' + BLUE + '"/></svg>',
    writer:
      '<svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l5 7-5 13-5-13z" fill="' + RUST + '" stroke="' + INK + '"/><path d="M7 9h10" fill="none" stroke="' + INK + '"/><circle cx="12" cy="13" r="1.4" fill="#ffffff" stroke="none"/></svg>',
  };

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.OMMHasDedicatedIcon = function (id) {
    return !!dedicated[id];
  };

  window.OMMIconClass = function (id) {
    return dedicated[id] ? ' dedicated' : '';
  };

  window.OMMIcon = function (id, glyph) {
    if (dedicated[id]) {
      return '<img class="app-icon-img" src="' + dedicated[id] + '" alt="" />';
    }
    if (icons[id]) return icons[id];
    return '<span class="app-glyph-text">' + escapeText(glyph || '?') + '</span>';
  };
})();
