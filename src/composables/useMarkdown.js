import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import katex from 'katex'
import texmath from 'markdown-it-texmath'

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>'
        )
      } catch {
        /* fallback below */
      }
    }
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>'
  },
})

md.use(texmath, {
  engine: katex,
  delimiters: 'dollars',
  katexOptions: { throwOnError: false },
})

const defaultImageRender =
  md.renderer.rules.image ||
  function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options, env, self)
  }

md.renderer.rules.image = function (tokens, idx, options, env, self) {
  tokens[idx].attrSet('loading', 'lazy')
  return defaultImageRender(tokens, idx, options, env, self)
}

/*
 * 内容来自静态 JSON，但 Markdown 开启了 raw HTML，直接 v-html 会成为存储型 XSS
 * 入口。这里在渲染后做一次白名单清洗：保留 KaTeX / highlight.js 依赖的 span/style，
 * 去掉脚本、事件属性、危险协议与不受信任的 iframe。
 */
const ALLOWED_TAGS = new Set([
  'DIV', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'IMG', 'PRE', 'CODE',
  'BLOCKQUOTE', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
  'HR', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'SUB', 'SUP', 'SMALL', 'MARK',
  'FIGURE', 'FIGCAPTION', 'SECTION', 'ARTICLE', 'DETAILS', 'SUMMARY', 'ABBR', 'CITE',
  'DEL', 'INS', 'DL', 'DT', 'DD', 'FONT', 'IFRAME',
])
const DROP_ENTIRELY = new Set([
  'SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'SELECT',
  'TEXTAREA', 'OBJECT', 'EMBED', 'APPLET', 'FRAME', 'FRAMESET', 'SVG', 'NOSCRIPT',
  'TEMPLATE', 'AUDIO', 'VIDEO', 'SOURCE', 'CANVAS',
])
const SAFE_ATTRS = new Set([
  'class', 'id', 'title', 'alt', 'src', 'href', 'width', 'height', 'align',
  'colspan', 'rowspan', 'style', 'loading', 'dir', 'lang', 'data-math', 'data-src',
])
const SAFE_URL = /^(https?:\/\/|mailto:|\/|#|\.\/|\.\.\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,)/i
const IFRAME_HOSTS = ['player.bilibili.com', 'www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com']

function safeUrl(value) {
  return SAFE_URL.test(String(value || '').trim())
}

function safeStyle(value) {
  return String(value || '')
    .replace(/url\s*\([^)]*\)/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/-moz-binding\s*:[^;]+;?/gi, '')
    .replace(/behavior\s*:[^;]+;?/gi, '')
    .replace(/@import[^;]+;?/gi, '')
    .replace(/javascript\s*:/gi, '')
}

function sanitizeNode(node, allowIframe) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 1) {
      // MathML（KaTeX 输出）与 SVG 之外的命名空间：保留 trusted 的 KaTeX 结构。
      const isMathML = child.namespaceURI === 'http://www.w3.org/1998/Math/MathML'
      const tag = child.tagName

      if (DROP_ENTIRELY.has(tag)) {
        child.remove()
        continue
      }
      if (!isMathML && tag === 'IFRAME' && !allowIframe) {
        child.remove()
        continue
      }
      if (!isMathML && !ALLOWED_TAGS.has(tag)) {
        // 未知标签拆开保留其文字，避免吞掉正文。
        child.replaceWith(...Array.from(child.childNodes))
        continue
      }

      // MathML（KaTeX 输出）保留其专有标签与属性，但事件处理器、危险协议与
      // 危险 style 必须照常清理：原始 HTML 里的 <math> 同样进入 MathML 命名空间，
      // 不能仅凭命名空间就当作可信内容放过（否则 <math onmouseover=...> 可绕过白名单）。
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase()
        const value = attr.value
        if (name.startsWith('on') || (!isMathML && !SAFE_ATTRS.has(name))) {
          child.removeAttribute(attr.name)
          continue
        }
        if ((name === 'href' || name === 'src' || name === 'xlink:href') && !safeUrl(value)) {
          child.removeAttribute(attr.name)
          continue
        }
        if (name === 'style') {
          const cleaned = safeStyle(value)
          if (cleaned) child.setAttribute('style', cleaned)
          else child.removeAttribute('style')
        }
      }

      if (tag === 'IFRAME') {
        let host = ''
        try {
          host = new URL(child.getAttribute('src') || '', window.location.href).hostname
        } catch {
          host = ''
        }
        if (!IFRAME_HOSTS.includes(host)) {
          child.remove()
          continue
        }
        child.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups')
        child.setAttribute('referrerpolicy', 'no-referrer')
      }
      if (tag === 'A') {
        child.setAttribute('rel', 'noopener noreferrer')
      }
      sanitizeNode(child, allowIframe)
    }
  }
}

function sanitizeHtml(html, allowIframe) {
  if (typeof window === 'undefined' || !window.DOMParser) return html
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const root = doc.getElementById('root')
  if (!root) return ''
  sanitizeNode(root, allowIframe)
  return root.innerHTML
}

export function renderMarkdown(content, options = {}) {
  if (!content) return ''
  return sanitizeHtml(md.render(content), options.allowIframe !== false)
}

export function renderMarkdownInline(content) {
  if (!content) return ''
  return sanitizeHtml(md.renderInline(content), false)
}

export function getPlainText(content, maxLen = 80) {
  if (!content) return ''
  const text = content
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\$\$[\s\S]*?\$\$/g, '[math]')
    .replace(/\$[^$]+\$/g, '[math]')
    .replace(/!\[.*?\]\(.*?\)/g, '[image]')
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
    .replace(/[#*`~>_-]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text
}
