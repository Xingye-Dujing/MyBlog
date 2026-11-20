/* Markdown 输出清洗回归测试（node:test）
 * useMarkdown.js 依赖浏览器的 DOMParser；这里用最小 DOM 桩在 VM 中执行同一段
 * 清洗逻辑，验证白名单不会被 MathML 命名空间绕过。
 * 运行：node --test tests/test_markdown_sanitizer.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const source = readFileSync(new URL('src/composables/useMarkdown.js', ROOT), 'utf8')

const start = source.indexOf('const ALLOWED_TAGS')
const end = source.indexOf('function sanitizeHtml(')
assert.notEqual(start, -1, 'ALLOWED_TAGS 未找到')
assert.notEqual(end, -1, 'sanitizeHtml 未找到')
const code = source.slice(start, end) + '\nreturn { sanitizeNode, safeUrl, safeStyle }'
const { sanitizeNode, safeUrl } = vm.runInNewContext(
  `(function () { ${code} })()`,
  { Set, Array, String, Math, Object, Number, URL,
    window: { location: { href: 'https://example.com/blog/' } } },
)

const HTML = 'http://www.w3.org/1999/xhtml'
const MATH = 'http://www.w3.org/1998/Math/MathML'

function el(tag, ns, attrs = [], children = []) {
  const node = {
    nodeType: 1,
    tagName: ns === HTML ? tag.toUpperCase() : tag,
    namespaceURI: ns,
    attributes: attrs.map(([name, value]) => ({ name, value })),
    childNodes: [],
    parentNode: null,
    getAttribute(name) {
      const a = this.attributes.find((x) => x.name === name)
      return a ? a.value : null
    },
    setAttribute(name, value) {
      const a = this.attributes.find((x) => x.name === name)
      if (a) a.value = value
      else this.attributes.push({ name, value })
    },
    removeAttribute(name) {
      this.attributes = this.attributes.filter((x) => x.name !== name)
    },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.childNodes.indexOf(this)
        if (i >= 0) this.parentNode.childNodes.splice(i, 1)
        this.parentNode = null
      }
    },
    replaceWith(...nodes) {
      if (this.parentNode) {
        const i = this.parentNode.childNodes.indexOf(this)
        if (i >= 0) {
          this.parentNode.childNodes.splice(i, 1, ...nodes)
          nodes.forEach((n) => { n.parentNode = this.parentNode })
        }
        this.parentNode = null
      }
    },
  }
  children.forEach((c) => { c.parentNode = node; node.childNodes.push(c) })
  return node
}

function clean(children, allowIframe = false) {
  const root = el('div', HTML, [], children)
  sanitizeNode(root, allowIframe)
  return root
}

test('MathML 命名空间不能绕过事件属性与危险 URL 清洗', () => {
  const math = el('math', MATH, [
    ['onmouseover', 'alert(1)'],
    ['xlink:href', 'javascript:alert(2)'],
    ['style', 'color:red;background:url(javascript:alert(3))'],
    ['encoding', 'application/x-tex'],
  ])
  const root = clean([math])
  assert.equal(root.childNodes.length, 1)
  assert.equal(math.getAttribute('onmouseover'), null)
  assert.equal(math.getAttribute('xlink:href'), null)
  assert.equal(math.getAttribute('encoding'), 'application/x-tex')
  assert.ok(!/url\(/i.test(math.getAttribute('style') || ''))
})

test('MathML 中嵌套的可疑链接与子节点同样被清洗', () => {
  const link = el('a', MATH, [['xlink:href', 'javascript:alert(1)'], ['onclick', 'evil()']])
  const math = el('math', MATH, [], [link])
  clean([math])
  assert.equal(link.getAttribute('xlink:href'), null)
  assert.equal(link.getAttribute('onclick'), null)
})

test('KaTeX 常用的 class 与 style 在清洗后保留', () => {
  const span = el('span', HTML, [
    ['class', 'katex'],
    ['style', 'height:1.2em;color:#333'],
  ])
  clean([span])
  assert.equal(span.getAttribute('class'), 'katex')
  assert.equal(span.getAttribute('style'), 'height:1.2em;color:#333')
})

test('普通 HTML 的危险协议、事件属性与脚本仍被处理', () => {
  const a = el('a', HTML, [
    ['href', 'javascript:alert(1)'],
    ['onclick', 'evil()'],
  ])
  const script = el('script', HTML, [], [])
  clean([a, script])
  assert.equal(a.getAttribute('href'), null)
  assert.equal(a.getAttribute('onclick'), null)
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(script.parentNode, null)
})

test('safeUrl 允许站点内与白名单协议，拒绝 javascript/data 脚本', () => {
  assert.equal(safeUrl('https://example.com/a'), true)
  assert.equal(safeUrl('/img/a.png'), true)
  assert.equal(safeUrl('#section'), true)
  assert.equal(safeUrl('javascript:alert(1)'), false)
  assert.equal(safeUrl('data:text/html;base64,PHNjcmlwdD4='), false)
})
