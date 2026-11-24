/* Shared HTML whitelist regression tests (node:test)
 * Run: node --test tests/test_markdown_sanitizer.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const source = readFileSync(new URL('public/lib/zen-html.js', ROOT), 'utf8')
const ctx = {
  Set, Array, String, Math, Object, Number, URL,
  window: { location: { href: 'https://example.com/blog/' } },
}
ctx.window.window = ctx.window
vm.createContext(ctx)
vm.runInContext(source, ctx)
const ZenHTML = ctx.window.ZenHTML
const opts = ZenHTML.options({ allowIframe: false })

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
        if (i >= 0) this.parentNode.childNodes.splice(i, 1, ...nodes)
        nodes.forEach((n) => { n.parentNode = this.parentNode })
        this.parentNode = null
      }
    },
  }
  children.forEach((c) => { c.parentNode = node; node.childNodes.push(c) })
  return node
}

function clean(children, allowIframe = false) {
  const root = el('div', HTML, [], children)
  ZenHTML.sanitizeNode(root, ZenHTML.options({ allowIframe }))
  return root
}

test('MathML 命名空间不能绕过事件属性、危险 URL 与 style 清洗', () => {
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
  assert.ok(!/url\(/i.test(math.getAttribute('style') || ''))
  assert.equal(math.getAttribute('encoding'), 'application/x-tex')
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

test('未知标签拆包后，被提升的子节点仍须重新清洗', () => {
  const img = el('img', HTML, [
    ['src', 'x'],
    ['onerror', 'alert(document.cookie)'],
  ])
  const link = el('a', HTML, [['href', 'javascript:alert(1)']])
  const nested = el('foo', HTML, [], [link])
  const unknown = el('center', HTML, [], [img, nested])
  const root = clean([unknown])
  assert.equal(root.childNodes.length, 2)
  assert.equal(img.parentNode, root)
  assert.equal(img.getAttribute('onerror'), null)
  assert.equal(link.getAttribute('href'), null)
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer')
})

test('safeUrl 允许站点内与白名单协议，拒绝 javascript/data 脚本', () => {
  assert.equal(ZenHTML.safeUrl('https://example.com/a'), true)
  assert.equal(ZenHTML.safeUrl('/img/a.png'), true)
  assert.equal(ZenHTML.safeUrl('#section'), true)
  assert.equal(ZenHTML.safeUrl('javascript:alert(1)'), false)
  assert.equal(ZenHTML.safeUrl('data:text/html;base64,PHNjcmlwdD4='), false)
})

test('style 白名单不被 CSS 转义绕过', () => {
  const payload = 'width:1px\\3b position\\3a fixed\\3b top\\3a 0\\3b z-index\\3a 9999'
  assert.equal(ZenHTML.safeStyle(payload), '')
  assert.ok(!/position|z-index/i.test(ZenHTML.safeStyle(payload)))
  assert.equal(ZenHTML.safeStyle('color:red;font-weight:bold'), 'color:red;font-weight:bold')
})

test('Writer 富文本配置不允许 id 与 data 属性逃逸', () => {
  assert.equal(ZenHTML.richTextAttrs.includes('id'), false)
  assert.equal(ZenHTML.richTextAttrs.includes('class'), true)
  assert.equal(ZenHTML.richTextAttrs.includes('style'), true)
})
