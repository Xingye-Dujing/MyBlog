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
      } catch (_) {
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

export function renderMarkdown(content) {
  if (!content) return ''
  return md.render(content)
}

export function renderMarkdownInline(content) {
  if (!content) return ''
  return md.renderInline(content)
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
