/* 共享资产底线：产品不得自带视觉基座、Toast、原生弹窗或私有浮层。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const exists = (p) => existsSync(new URL(p, ROOT))

const PRODUCTS = [
  'ai', 'annotate', 'corpus', 'data', 'english', 'hub', 'latex', 'mdforge', 'message',
  'planner', 'redact', 'search', 'visualization', 'writer', 'video', 'table',
  'zencard', 'zenflow', 'zenclip', 'zenreview', 'zenbackup',
]
const PAGES = [...PRODUCTS.map((id) => `public/omm-${id}.html`), 'public/index.html']
const CORE = [
  'zen/components/layer.js', 'zen/components/toast.js', 'zen/components/dialog.js',
  'zen/components/select.js', 'zen/components/menu.js', 'zen/components/shortcuts.js',
  'zen/components/index.js',
]

test('每个产品都引用共享核心资产（含 Lambda 入口页）', () => {
  for (const page of PAGES) {
    const text = read(page)
    assert.ok(text.includes('zen/zen.css'), `${page} 未引入 zen.css`)
    for (const asset of CORE) {
      assert.ok(text.includes(asset), `${page} 未接入 ${asset}`)
    }
  }
})

test('无废弃兼容别名回潮', () => {
  const files = [
    ...PAGES,
    'public/lib/zen-table.js', 'public/lib/zen-video.js', 'public/lib/zen-link.js',
    'public/zen/components/select.js', 'public/zen/components/index.js',
    'public/zen/components/components.css',
  ]
  for (const file of files) {
    assert.ok(!read(file).includes('data-omm-select'), `${file} 仍使用废弃的 data-omm-select`)
  }
})

test('产品不再自带 Toast 节点与 DOM 实现', () => {
  for (const page of PAGES) {
    const text = read(page)
    assert.ok(!/<div[^>]*\bid="(?:toast|notification)"/i.test(text),
      `${page} 仍自带 Toast/通知节点`)
    const domToast = /function\s+(?:toast|notify)\s*\([^)]*\)\s*\{(?:(?!ZenUI\.toast)[\s\S]){0,400}?\b(?:getElementById|\$|classList\.add)\b/.test(text)
    assert.ok(!domToast, `${page} 仍有操作 DOM 的私有 Toast 实现`)
  }
  for (const lib of ['public/lib/zen-table.js', 'public/lib/zen-video.js', 'public/lib/zen-link.js']) {
    assert.ok(!/zen-link-toast|getElementById\(['"]toast['"]\)/.test(read(lib)),
      `${lib} 仍自带 Toast 节点`)
  }
})

test('产品不再自带通用模态壳，统一使用 ZenUI.modal', () => {
  for (const page of PAGES) {
    const text = read(page)
    assert.ok(!/<div[^>]*\bid="modal"/i.test(text), `${page} 仍自带 #modal 壳`)
    assert.ok(!/id="preview-modal"|id="cat-modal"|id="help-modal"/i.test(text),
      `${page} 仍自带私有模态壳`)
    // Writer 的云同步弹窗与画布一起，留待画布迁移时一并处理。
    if (page.includes('writer')) continue
    if (/function\s+(?:openModal|showModal|modalOpen)\s*\(/.test(text) ||
        /\b(?:openModal|showModal)\s*\([^)]*\)\s*\{/.test(text)) {
      assert.ok(text.includes('ZenUI.modal.open'), `${page} 的模态实现未委托共享组件`)
    }
  }
})

test('产品不使用原生弹窗与原生对话框元素', () => {
  for (const page of PAGES) {
    const text = read(page)
    assert.ok(!/(?<![.\w])(?:window\.)?(?:alert|confirm|prompt)\s*\(\s*['"`]/.test(text),
      `${page} 仍有原生弹窗`)
    assert.ok(!/<\s*dialog\b/i.test(text), `${page} 仍有 <dialog> 元素`)
    const nativeModals = [...text.matchAll(/\.showModal\s*\(/g)]
      .filter((m) => text.lastIndexOf('UIMgr', m.index) !== m.index - 5)
    assert.equal(nativeModals.length, 0, `${page} 仍调用原生 showModal`)
  }
})

test('zen/ 目录职责单一且名称互不重叠', () => {
  const dir = fileURLToPath(new URL('../public/zen/', import.meta.url))
  const folders = new Set(readdirSync(dir).filter((name) =>
    statSync(join(dir, name)).isDirectory()))
  for (const name of ['foundation', 'components', 'canvas', 'features', 'products']) {
    assert.ok(folders.has(name), `缺少职责目录 ${name}`)
  }
  for (const retired of ['styles', 'ui', 'base']) {
    assert.ok(!folders.has(retired), `已废弃目录 ${retired} 不应存在`)
  }
  assert.ok(exists('public/zen/zen.css'), '缺少统一样式入口')
})

test('通用助手统一引用共享 ZenUtil，不再各自实现', () => {
  const util = read('public/zen/foundation/util.js')
  for (const key of ['byId', 'tpl', 'setText', 'toggleCls', 'autosize', 'nz', 'low', 'kz', 'nowISO', 'pad', 'str', 'arr', 'isTableMissing', 'esc', 'uid', 'download', 'copy', 'safeName', 'escRe']) {
    assert.ok(util.includes('u.' + key + ' ='), `ZenUtil 缺少 ${key}`)
  }
  const migrated = ['annotate', 'corpus', 'data', 'english', 'planner', 'writer']
  const delegates = ['E', 'tpl', 'setText', 'toggleCls', 'nz', 'low', 'kz', 'nowISO', 'pad', 'isTableMissing', 'autosizeSql']
  for (const id of migrated) {
    const page = `public/omm-${id}.html`
    const text = read(page)
    assert.ok(text.includes('zen/foundation/util.js'), `${page} 未接入共享 util`)
    for (const name of delegates) {
      const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}', 'g')
      for (const m of text.matchAll(re)) {
        // writer/annotate 的 autosizeSql 是产品专有实现（固定高度 / 自动填 SQL），保留
        if (name === 'autosizeSql' && (id === 'writer' || id === 'annotate')) continue
        assert.ok(m[1].includes('ZenUtil'), `${page} 的 ${name}() 未委托共享实现`)
      }
    }
  }
})

test('HTML 转义 / uid / 下载 / 复制 / 安全文件名统一委托 ZenUtil', () => {
  const helpers = ['esc', 'escapeHtml', 'escape', 'uid', 'download', 'copyText', 'safeName', 'escRe', 'escapeRegex']
  for (const page of PAGES) {
    const text = read(page)
    for (const name of helpers) {
      const fns = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\}', 'g')
      for (const m of text.matchAll(fns)) {
        assert.ok(/ZenUtil/.test(m[1]), `${page} 的 ${name}() 仍自行实现：${m[1].slice(0, 60)}`)
      }
      const arrows = new RegExp('const\\s+' + name + '\\s*=\\s*\\([^)]*\\)\\s*=>\\s*([^\\n]+)', 'g')
      for (const m of text.matchAll(arrows)) {
        assert.ok(/ZenUtil/.test(m[1]), `${page} 的 ${name} 箭头实现仍自行处理：${m[1].slice(0, 60)}`)
      }
    }
  }
})

test('旧 toast 计时器残留已清理', () => {
  for (const page of PAGES) {
    const text = read(page)
    assert.ok(!/\b(?:let|var)\s+(?:toastTimer|notifyTimer)\s*=/.test(text), `${page} 仍有私有 toast 计时器`)
    assert.ok(!/\bnotifyTimer\s*:\s*null/.test(text), `${page} 仍有 notifyTimer 字段残留`)
  }
})

test('安装器外观设置使用共享 ZenUI.modal，无私有对话框', () => {
  const page = read('public/installer.html')
  const js = read('public/installer.js')
  assert.ok(page.includes('zen/components/dialog.js'), '安装器未加载共享 dialog')
  assert.ok(js.includes('ZenUI.modal.open'), '安装器未使用 ZenUI.modal')
  assert.ok(!page.includes('id="settings"'), '安装器仍有私有 settings 对话框节点')
  assert.ok(!js.includes('els.settings'), '安装器仍保留私有对话框引用')
})

test('下拉浮层统一用共享 ZenUI.popover，不再各自定位', () => {
  const users = ['mdforge', 'search', 'writer', 'latex', 'visualization']
  for (const id of users) {
    const page = `public/omm-${id}.html`
    const text = read(page)
    assert.ok(text.includes('zen/components/popover.js'), `${page} 未接入共享 popover`)
    assert.ok(text.includes('ZenUI.popover.open'), `${page} 未使用 ZenUI.popover.open`)
    // 私有的浮层定位/互斥实现必须已删除（保留产品自身的副作用编排不算）
    assert.ok(!/className\s*=\s*['"]dropdown open['"]/.test(text), `${page} 仍自管浮层 open 类`)
  }
})

test('Writer 富右键菜单的定位/关闭委托共享 ZenUI.contextMenu', () => {
  const text = read('public/omm-writer.html')
  assert.ok(text.includes('zen/components/context-menu.js'), 'Writer 未接入共享 context-menu')
  assert.ok(text.includes('ZenUI.contextMenu.open'), 'Writer 未使用 ZenUI.contextMenu.open')
  assert.ok(!text.includes("DOM.contextMenu.classList.remove('open')"),
    'Writer 仍自行关闭右键菜单')
  // 菜单内容仍是产品自己的模板与动作分派，不应被移除
  assert.ok(text.includes('id="context-menu"'), 'Writer 右键菜单模板被误删')
})

test('Writer 的锚定浮层定位/关闭均委托共享组件', () => {
  const text = read('public/omm-writer.html')
  assert.ok(text.includes('ZenUI.popover.open'), 'Writer 基准菜单未委托 popover')
  assert.ok(text.includes('ZenUI.popover.place'), 'Writer 引用预览定位未复用共享几何')
  assert.ok(!text.includes("this._menu.classList.remove('open')"), 'Writer 基准菜单仍自行关闭')
  assert.ok(!text.includes("if (!this._menuOpen) return"), 'Writer 基准菜单仍有私有外部关闭逻辑')
  // 节点边框 / 节点类型浮层也走共享 popover，保留产品自己的 .active 外观
  assert.ok(text.includes("openClass: 'active'"), 'Writer 节点浮层未复用共享 popover 外观配置')
  assert.ok(!text.includes("pop.classList.add('active')"), 'Writer 节点浮层仍自管 open 状态')
})

test('产品自建浮层/日历/选择器残留已清除', () => {
  const noPrivate = {
    'omm-corpus.html': ['initCustomSelects', 'positionCustomSelect', 'closeCustomSelects', 'custom-select-trigger'],
    'omm-data.html': ['Csel.position', 'Fsel.position', "style.left = '-9999px'"],
    'omm-english.html': ['renderExamPop', 'function hidePop', 'id="pop-voice"', 'id="pop-exam"', 'EP.y'],
    'omm-planner.html': ['id="pop-date"', 'id="pop-time"', 'id="pop-multidate"', 'id="pop-enddate"', 'ED_GUARD'],
    'omm-annotate.html': ['function placePop', 'function closeDrops'],
    'omm-redact.html': ['dd.style.top =', 'dd.style.left ='],
  }
  for (const [page, tokens] of Object.entries(noPrivate)) {
    const text = read(`public/${page}`)
    for (const token of tokens) {
      assert.ok(!text.includes(token), `${page} 仍残留 ${token}`)
    }
  }
  for (const id of ['annotate', 'redact', 'planner', 'data', 'corpus', 'english']) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(text.includes('ZenUI.popover.open'), `omm-${id}.html 未委托 ZenUI.popover`)
  }
  assert.ok(read('public/omm-english.html').includes('ZenUI.picker.open'), 'English 未委托 ZenUI.picker')
  const annotate = read('public/omm-annotate.html')
  assert.ok(annotate.includes('zen/components/tooltip.js'), 'Annotate 未加载共享 tooltip')
  assert.ok(annotate.includes('ZenUI.tooltip.showAt'), 'Annotate 富提示未委托共享 tooltip')
  assert.ok(!annotate.includes('id="tip"'), 'Annotate 仍有私有 tip 节点')
})

test('标签切换委托共享 ZenUI.tabs，保留产品自己的面板业务', () => {
  for (const id of ['zencard', 'ai', 'zenflow', 'mdforge']) {
    const page = `public/omm-${id}.html`
    const text = read(page)
    assert.ok(text.includes('zen/components/tabs.js'), `${page} 未加载共享 tabs`)
    assert.ok(text.includes('data-zen-tabs'), `${page} 未声明 data-zen-tabs`)
    assert.ok(text.includes('zen:tab'), `${page} 未订阅 zen:tab 事件`)
  }
  const lambda = read('public/index.html')
  assert.ok(lambda.includes('zen/components/tabs.js'), 'Lambda 页未加载共享 tabs')
  assert.ok(lambda.includes('data-zen-tabs'), 'Lambda 页未声明 data-zen-tabs')
  assert.ok(lambda.includes('zen:tab'), 'Lambda 页未订阅 zen:tab 事件')
})

test('Hub 右键菜单使用共享 ZenUI.menu，无私有 ctx-menu', () => {
  const page = read('public/omm-hub.html')
  const js = read('public/omm-hub.js')
  assert.ok(!page.includes('id="ctx-menu"'), 'Hub 仍有私有 ctx-menu 节点')
  assert.ok(!js.includes('data-ctx') && !js.includes('data-tab-ctx'), 'Hub 仍有私有右键菜单绑定')
  assert.ok(js.includes('ZenUI.menu.open'), 'Hub 未使用共享 ZenUI.menu')
})

test('全局键盘快捷键统一委托 ZenUI.shortcuts，不再手写修饰键判断', () => {
  const users = ['index', 'annotate', 'corpus', 'data', 'english', 'latex', 'mdforge',
    'message', 'planner', 'redact', 'search', 'visualization', 'writer']
  for (const id of users) {
    const page = id === 'index' ? 'public/index.html' : `public/omm-${id}.html`
    const text = read(page)
    assert.ok(text.includes('ZenUI.shortcuts.bind'), `${page} 未委托 ZenUI.shortcuts`)
  }
  // 死代码：Lambda 页旧的 select/modal/toast 自建 CSS 与 initSelect 调用已删除
  const lambda = read('public/index.html')
  const lambdaCss = read('public/zen/products/lambda.css')
  assert.ok(!lambda.includes('initSelect('), 'Lambda 仍保留 initSelect 死调用')
  assert.ok(!/\.modal\s*\{|\.toast\s*\{|(?<![\w-])\.sel(-btn|-menu|-opt)?\s*\{/.test(lambdaCss),
    'lambda.css 仍有自建 modal/toast/select 死样式')
})

test('ZenUtil 提供通用文件读取 / JSON 存储 / 拖放接线', () => {
  const util = read('public/zen/foundation/util.js')
  for (const key of ['clamp', 'clamp01', 'clone', 'lsGet', 'lsSet', 'lsDel', 'debounce',
    'fmtDate', 'fileStamp', 'tags', 'saveJSON', 'readText', 'readTexts',
    'getJSON', 'setJSON', 'removeJSON', 'enableFileDrop']) {
    assert.ok(util.includes('u.' + key + ' ='), `ZenUtil 缺少 ${key}`)
  }
})

test('可视化生成物的快捷键来自 transform overlay', () => {
  const html = read('public/omm-visualization.html')
  assert.ok(html.includes('ZenUI.shortcuts.bind'), '生成物未委托共享快捷键')
  assert.ok(!html.includes('const mod = e.metaKey'), '生成物仍有手写修饰键判断')
})

test('共享快捷键匹配 space / Shift 标点 / 字面 +', () => {
  const src = read('public/zen/components/shortcuts.js')
  assert.ok(src.includes("k === ' '"), '共享快捷键未归一化空格键')
  assert.ok(src.includes('SHIFTED'), '共享快捷键未处理 Shift 标点')
  assert.ok(src.includes("=== '+'"), '共享快捷键未处理字面 +')
  assert.ok(src.includes('hasOpen()'), '共享快捷键未避开已打开的浮层')
  const layer = read('public/zen/components/layer.js')
  assert.ok(layer.includes('wireOverlay'), '共享层缺少通用抽屉/面板接线')
  assert.ok(layer.includes('hasOpen:'), '共享层缺少 hasOpen 查询')
})

test('抽屉/底部面板的开合机制委托共享 ZenUI.layer.wireOverlay', () => {
  for (const id of ['annotate', 'data', 'corpus', 'english', 'planner']) {
    const page = `public/omm-${id}.html`
    const text = read(page)
    assert.ok(text.includes('ZenUI.layer.wireOverlay'), `${page} 未委托共享抽屉接线`)
    assert.ok(text.includes('isOpen()'), `${page} 未防止抽屉重复入栈`)
  }
})

test('自建浮层定位残留已清除', () => {
  const data = read('public/omm-data.html')
  assert.ok(data.includes('ZenUI.tooltip.showAt'), 'Data 单元格预览未走共享 tooltip')
  assert.ok(!data.includes('cell-preview'), 'Data 仍有私有预览节点')
  const latex = read('public/omm-latex.html')
  assert.ok(latex.includes('ZenUI.popover.place'), 'LaTeX 补全未复用共享定位')
  assert.ok(!latex.includes('id="editor-autocomplete"'), 'LaTeX 仍有私有补全节点')
})

test('多文件读取与拖放接线委托共享 ZenUtil', () => {
  for (const id of ['annotate', 'corpus', 'english']) {
    const page = `public/omm-${id}.html`
    const text = read(page)
    assert.ok(text.includes('ZenUtil.readTexts'), `${page} 未委托共享文件读取`)
    assert.ok(!/let pending = arr\.length|var pending = arr\.length/.test(text), `${page} 仍有自建 pending 计数器`)
  }
  const redact = read('public/omm-redact.html')
  assert.ok(redact.includes('ZenUtil.enableFileDrop'), 'Redact 未委托共享拖放接线')
})
