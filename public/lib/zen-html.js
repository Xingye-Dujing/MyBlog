/* OMM-ZEN shared · HTML sanitiser
 * ------------------------------------------------------------------
 * One whitelist implementation for blog Markdown and product rich text.
 * Classic script so standalone product pages can load it synchronously;
 * exposes window.ZenHTML and has no product-specific branches.
 *
 * API: ZenHTML.sanitize(html, opts)
 * opts: { allowIframe, tags, attrs, iframeHosts }
 */
;(function (global) {
  'use strict'

  var ALLOWED_TAGS = [
    'DIV', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'IMG', 'PRE', 'CODE',
    'BLOCKQUOTE', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
    'HR', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'SUB', 'SUP', 'SMALL', 'MARK',
    'FIGURE', 'FIGCAPTION', 'SECTION', 'ARTICLE', 'DETAILS', 'SUMMARY', 'ABBR', 'CITE',
    'DEL', 'INS', 'DL', 'DT', 'DD', 'FONT', 'IFRAME',
  ]
  var DROP_ENTIRELY = [
    'SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'SELECT',
    'TEXTAREA', 'OBJECT', 'EMBED', 'APPLET', 'FRAME', 'FRAMESET', 'SVG', 'NOSCRIPT',
    'TEMPLATE', 'AUDIO', 'VIDEO', 'SOURCE', 'CANVAS',
  ]
  var SAFE_ATTRS = [
    'class', 'id', 'title', 'alt', 'src', 'href', 'width', 'height', 'align',
    'colspan', 'rowspan', 'style', 'loading', 'dir', 'lang', 'data-math', 'data-src',
  ]
  var RICH_TEXT_ATTRS = [
    'class', 'title', 'alt', 'src', 'href', 'width', 'height', 'align',
    'colspan', 'rowspan', 'style', 'loading', 'dir', 'lang',
  ]
  var SAFE_URL = /^(https?:\/\/|mailto:|\/|#|\.\/|\.\.\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,)/i
  var IFRAME_HOSTS = [
    'player.bilibili.com', 'www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com',
  ]
  var SAFE_STYLE_PROPS = [
    'color', 'background-color', 'font-size', 'font-style', 'font-weight', 'font-family',
    'text-align', 'text-decoration', 'line-height', 'vertical-align', 'white-space',
    'height', 'width', 'max-width', 'min-width', 'margin', 'margin-left', 'margin-right',
    'margin-top', 'margin-bottom', 'padding', 'padding-left', 'padding-right',
    'padding-top', 'padding-bottom', 'border', 'border-color', 'float',
  ]

  function toSet(list) { return new Set(list) }

  function safeUrl(value) {
    return SAFE_URL.test(String(value || '').trim())
  }

  /* Only typography/layout-safe inline properties. Reject CSS escapes before
   * parsing so escaped separators cannot reassemble forbidden declarations. */
  function safeStyle(value) {
    var text = String(value || '')
      .replace(/url\s*\([^)]*\)/gi, '')
      .replace(/expression\s*\([^)]*\)/gi, '')
      .replace(/-moz-binding\s*:[^;]+;?/gi, '')
      .replace(/behavior\s*:[^;]+;?/gi, '')
      .replace(/@import[^;]+;?/gi, '')
      .replace(/javascript\s*:/gi, '')
    return text.split(';').map(function (part) {
      if (part.indexOf('\\') >= 0) return ''
      var colon = part.indexOf(':')
      if (colon < 0) return ''
      var prop = part.slice(0, colon).trim().toLowerCase()
      var val = part.slice(colon + 1).trim()
      if (SAFE_STYLE_PROPS.indexOf(prop) < 0 || !val || /[{}<>]/.test(val)) return ''
      return prop + ':' + val
    }).filter(Boolean).join(';')
  }

  function options(opts) {
    var o = opts || {}
    return {
      allowIframe: !!o.allowIframe,
      tags: o.tags ? toSet(o.tags) : toSet(ALLOWED_TAGS),
      attrs: o.attrs ? toSet(o.attrs) : toSet(SAFE_ATTRS),
      drop: toSet(DROP_ENTIRELY),
      iframeHosts: o.iframeHosts || IFRAME_HOSTS,
    }
  }

  function sanitizeElement(child, opts) {
    var isMathML = child.namespaceURI === 'http://www.w3.org/1998/Math/MathML'
    var tag = child.tagName.toUpperCase()

    if (opts.drop.has(tag)) {
      child.remove()
      return
    }
    if (!isMathML && tag === 'IFRAME' && !opts.allowIframe) {
      child.remove()
      return
    }
    if (!isMathML && !opts.tags.has(tag)) {
      var moved = Array.from(child.childNodes)
      child.replaceWith.apply(child, moved)
      moved.forEach(function (node) {
        if (node.nodeType === 1) sanitizeElement(node, opts)
      })
      return
    }

    Array.from(child.attributes).forEach(function (attr) {
      var name = attr.name.toLowerCase()
      var value = attr.value
      if (name.indexOf('on') === 0 || (!isMathML && !opts.attrs.has(name))) {
        child.removeAttribute(attr.name)
        return
      }
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && !safeUrl(value)) {
        child.removeAttribute(attr.name)
        return
      }
      if (name === 'style') {
        var cleaned = safeStyle(value)
        if (cleaned) child.setAttribute('style', cleaned)
        else child.removeAttribute('style')
      }
    })

    if (tag === 'IFRAME') {
      var host = ''
      try {
        host = new URL(child.getAttribute('src') || '', global.location.href).hostname
      } catch (_) { host = '' }
      if (opts.iframeHosts.indexOf(host) < 0) {
        child.remove()
        return
      }
      child.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups')
      child.setAttribute('referrerpolicy', 'no-referrer')
    }
    if (tag === 'A') child.setAttribute('rel', 'noopener noreferrer')
    sanitizeNode(child, opts)
  }

  function sanitizeNode(node, opts) {
    Array.from(node.childNodes).forEach(function (child) {
      if (child.nodeType === 1) sanitizeElement(child, opts)
    })
  }

  function sanitize(html, opts) {
    if (!global.DOMParser) return ''
    var doc = new global.DOMParser().parseFromString(
      '<div id="root">' + String(html == null ? '' : html) + '</div>', 'text/html')
    var root = doc.getElementById('root')
    if (!root) return ''
    sanitizeNode(root, options(opts))
    return root.innerHTML
  }

  global.ZenHTML = {
    sanitize: sanitize,
    sanitizeNode: sanitizeNode,
    sanitizeElement: sanitizeElement,
    options: options,
    safeUrl: safeUrl,
    safeStyle: safeStyle,
    allowedTags: ALLOWED_TAGS,
    safeAttrs: SAFE_ATTRS,
    richTextAttrs: RICH_TEXT_ATTRS,
    dropTags: DROP_ENTIRELY,
    iframeHosts: IFRAME_HOSTS,
  }
})(window)
