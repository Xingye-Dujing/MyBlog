/* 共享资产底线：产品不得自带视觉基座、Toast、原生弹窗或私有浮层。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'

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

test('ZenUtil 跨窗口消息只信任精确父 Hub 或同源父窗口', () => {
  const source = read('public/zen/foundation/util.js')
  const parent = {}
  const window = {
    parent,
    location: {
      origin: 'http://127.0.0.1:8311',
      search: '?omm_embed=1&omm_hub_origin=http%3A%2F%2F127.0.0.1%3A8300',
    },
  }
  const context = { window, URL, URLSearchParams }
  vm.runInNewContext(source, context)
  const trust = context.window.ZenUtil.isTrustedParentMessage
  assert.equal(context.window.ZenUtil.parentTargetOrigin(), 'http://127.0.0.1:8300')
  assert.equal(trust({ source: parent, origin: 'http://127.0.0.1:8300' }), true)
  assert.equal(trust({ source: {}, origin: 'http://127.0.0.1:8300' }), false)
  assert.equal(trust({ source: parent, origin: 'http://127.0.0.1:9999' }), false)
  window.location.search = '?omm_embed=1'
  assert.equal(trust({ source: parent, origin: 'http://127.0.0.1:8300' }), false)
  window.location.search = '?omm_embed=1&omm_hub_origin=javascript%3Aalert(1)'
  assert.equal(trust({ source: parent, origin: 'null' }), false)
  assert.equal(context.window.ZenUtil.parentTargetOrigin(), 'http://127.0.0.1:8311')
  window.location.search = ''
  assert.equal(trust({ source: parent, origin: 'http://127.0.0.1:8311' }), true)
  assert.equal(trust({ source: parent, origin: 'http://127.0.0.1:8300' }), false)
  window.parent = window
  assert.equal(trust({ source: window, origin: 'http://127.0.0.1:8311' }), false)
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
  const hub = read('public/omm-hub.js')
  assert.ok(!/els\.toast\b|getElementById\(['"]toast['"]\)/.test(hub),
    'omm-hub.js 仍操作私有 Toast 节点')
  assert.ok(/function toast\([^)]*\)\s*\{\s*window\.ZenUI\.toast\(/.test(hub),
    'omm-hub.js 未委托 ZenUI.toast')
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
  for (const key of ['byId', 'tpl', 'setText', 'toggleCls', 'autosize', 'nz', 'low', 'kz', 'nowISO', 'pad', 'str', 'arr', 'isTableMissing', 'isLocalOrigin', 'parentTargetOrigin', 'isTrustedParentMessage', 'esc', 'uid', 'download', 'copy', 'safeName', 'escRe']) {
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
    'getJSON', 'setJSON', 'removeJSON', 'enableFileDrop', 'hashStr', 'fingerprint',
    'formatBytes', 'themeApply', 'themeInit', 'themeToggle']) {
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

test('主题应用与初始化统一委托 ZenUtil.theme*，不再直接操作 theme-dark', () => {
  const initIds = ['zenbackup', 'zencard', 'zenclip', 'zenflow', 'zenreview']
  for (const id of initIds) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(text.includes('ZenUtil.themeInit()'), `${id} 未委托主题初始化`)
    assert.ok(text.includes('ZenUtil.themeToggle()'), `${id} 未委托主题切换`)
  }
  const applyIds = ['corpus', 'annotate', 'data', 'english', 'message', 'planner',
    'writer', 'redact', 'mdforge', 'search']
  for (const id of applyIds) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(text.includes('ZenUtil.themeApply('), `${id} 未委托主题应用`)
  }
  assert.ok(read('public/omm-mdforge.html').includes("ZenUtil.themeApply(s.theme === 'night', 'theme-dark')"),
    'mdforge night 主题未委托共享应用')
  // 任何产品都不应再直接 toggle/add/remove 'theme-dark'
  for (const id of [...initIds, ...applyIds, 'ai', 'hub', 'latex', 'table', 'video',
    'visualization', 'zenbackup']) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(!/classList\.(?:add|remove|toggle)\(\s*['"]theme-dark['"]/.test(text),
      `${id} 仍直接操作 theme-dark class`)
  }
})

test('字节格式化与 textarea autosize 统一委托共享助手', () => {
  for (const id of ['redact', 'writer', 'mdforge']) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(text.includes('ZenUtil.formatBytes('), `${id} 未委托字节格式化`)
  }
  for (const [id, token] of [['annotate', 'ZenUtil.autosize('], ['message', 'ZenUtil.autosize('],
    ['index', 'ZenUtil.autosize(']]) {
    const page = id === 'index' ? 'public/index.html' : `public/omm-${id}.html`
    assert.ok(read(page).includes(token), `${page} 未委托 autosize`)
  }
})

test('已下沉的通用助手不留产品私有实现', () => {
  assert.ok(!/function\s+debounce\s*\(/.test(read('public/omm-planner.html')), 'Planner 仍有自建 debounce')
  assert.ok(!/function\s+fmtDate\s*\(/.test(read('public/omm-search.html')), 'Search 仍有自建 fmtDate')
  assert.ok(!/JSON\.parse\(JSON\.stringify/.test(read('public/omm-annotate.html')), 'Annotate 仍有内联深克隆')
  assert.ok(!/5381/.test(read('public/omm-corpus.html')), 'Corpus 仍有内联哈希')
  assert.ok(!/new FileReader\(/.test(read('public/omm-english.html')), 'English 仍有内联 FileReader')
  assert.ok(!/classList\.toggle\(\s*['"]theme-dark['"]/.test(read('public/omm-search.html')), 'Search 仍有内联主题切换')
})

test('blob 文件下载统一委托 ZenUtil.download / saveJSON', () => {
  const cases = [
    ['public/index.html', 'ZenUtil.download('],
    ['public/omm-corpus.html', 'ZenUtil.download('],
    ['public/omm-latex.html', 'ZenUtil.download('],
    ['public/omm-redact.html', 'ZenUtil.download('],
    ['public/omm-mdforge.html', 'ZenUtil.download('],
    ['public/omm-writer.html', 'ZenUtil.saveJSON('],
    ['public/omm-visualization.html', 'ZenUtil.saveJSON('],
    ['public/lib/zen-table.js', 'ZenUtil.saveJSON('],
    ['public/lib/zen-video.js', 'ZenUtil.saveJSON('],
  ]
  for (const [page, token] of cases) {
    assert.ok(read(page).includes(token), `${page} 未委托共享下载助手`)
  }
  assert.ok(/function\s+saveJSON\s*\([^)]*\)\s*\{\s*return ZenUtil\.saveJSON\(/.test(
    read('public/lib/omm-bridge.js')), '共享桥的 saveJSON 未委托共享实现')
  for (const id of ['annotate', 'corpus', 'english']) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(text.includes('src="lib/omm-bridge.js"'), `${id} 未加载共享桥（含 saveJSON 委托）`)
  }
  // 产品页与产品专用 lib 不得再自建 blob 下载骨架（index 的 WebM 字符串字面量除外）
  const pages = [
    ...['corpus', 'latex', 'redact', 'mdforge', 'writer', 'annotate', 'english',
      'table', 'video', 'visualization'].map((id) => `public/omm-${id}.html`),
    'public/lib/zen-table.js', 'public/lib/zen-video.js',
  ]
  for (const page of pages) {
    const text = read(page)
    const skeleton = /createObjectURL\s*\([^)]*\)[\s\S]{0,400}?\.download\s*=[\s\S]{0,200}?\.click\(\)/
    assert.ok(!skeleton.test(text), `${page} 仍有自建 blob 下载骨架`)
  }
  for (const page of ['public/omm-table.html', 'public/omm-video.html']) {
    assert.ok(read(page).includes('src="zen/foundation/util.js"'), `${page} 未加载共享 util.js`)
  }
})

test('剪贴板写入统一委托 ZenUtil.copy，不再裸用 navigator.clipboard', () => {
  for (const page of ['public/index.html', 'public/omm-corpus.html']) {
    const text = read(page)
    assert.ok(text.includes('ZenUtil.copy('), `${page} 未委托共享剪贴板`)
    assert.ok(!/navigator\.clipboard\.writeText/.test(text), `${page} 仍有裸剪贴板写入`)
  }
})

test('云同步 AES-GCM 信封统一委托 ZenCrypto.seal/unseal', () => {
  for (const id of ['annotate', 'corpus', 'data', 'english', 'planner', 'writer', 'message']) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(text.includes('src="lib/zen-crypto.js"'), `${id} 未加载共用加密模块`)
    assert.ok(text.includes('ZenCrypto.seal('), `${id} 未委托共享封装`)
    assert.ok(text.includes('ZenCrypto.unseal('), `${id} 未委托共享解封`)
    assert.ok(!/crypto\.subtle\.(encrypt|decrypt)/.test(text), `${id} 仍有内联加解密`)
    assert.ok(!/\bfunction (b64|ub64|keyFor)\s*\(/.test(text), `${id} 仍有内联加密原语`)
  }
})

test('三端 OMMBridge 下沉到共享库，产品只声明 data-self', () => {
  const lib = read('public/lib/omm-bridge.js')
  assert.ok(lib.includes('window.OMMBridge = {'), '共享桥未暴露 OMMBridge')
  assert.ok(lib.includes("script.getAttribute('data-self')"), '共享桥未从 data-self 读取自身 id')
  assert.ok(lib.includes("'omm-annotate'"), '共享桥应保留 APPS/FILES 中的产品名映射')
  for (const id of ['annotate', 'corpus', 'english']) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(text.includes('src="lib/omm-bridge.js"'), `${id} 未加载共享桥`)
    assert.ok(text.includes(`data-self="omm-${id}"`), `${id} 未声明自身 id`)
    assert.ok(!/<script id="omm-bridge-core">[\s\S]{200,}<\/script>/.test(text),
      `${id} 仍内联整块桥实现`)
    assert.ok(!/\bfunction (itWord|itSent|itDoc|take|watch|deliver)\s*\(/.test(text),
      `${id} 仍有内联桥函数`)
  }
})

test('跨窗口信任 / lsDel / fileStamp 等小助手不再自行实现', () => {
  const util = read('public/zen/foundation/util.js')
  assert.ok(util.includes('u.isLocalOrigin ='), 'ZenUtil 缺少 isLocalOrigin')
  assert.ok(util.includes('u.isTrustedParentMessage ='), 'ZenUtil 缺少统一消息信任校验')
  for (const page of ['public/index.html', 'public/lib/zen-table.js', 'public/lib/zen-video.js',
    'public/lib/zen-link.js', 'public/viz-bridge.js', 'public/omm-zenreview.html']) {
    const text = read(page)
    assert.ok(text.includes('ZenUtil.isTrustedParentMessage('), `${page} 未委托统一消息信任校验`)
    assert.ok(!/\bfunction localOrigin\s*\(/.test(text), `${page} 仍有内联 localOrigin`)
  }
  for (const page of ['public/omm-message.html', 'public/omm-writer.html']) {
    assert.ok(/function lsDel\(k\) \{ return ZenUtil\.lsDel\(k\) \}/.test(read(page)),
      `${page} 未委托 lsDel`)
  }
  assert.ok(/function fileStamp\(\)\{ return ZenUtil\.fileStamp\(null, true\) \}/.test(
    read('public/index.html')), 'index 未委托 fileStamp')
})

test('ZenUtil 提供 el / fmtDateTime，桥接脚本不再各自实现', () => {
  const util = read('public/zen/foundation/util.js')
  for (const key of ['el', 'fmtDateTime']) {
    assert.ok(util.includes('u.' + key + ' ='), `ZenUtil 缺少 ${key}`)
  }
  for (const file of ['public/omm-desktop.js', 'public/omm-share.js']) {
    const text = read(file)
    for (const name of ['fmtSize', 'fmtTime', 'el', 'copyText']) {
      assert.ok(!new RegExp('function\\s+' + name + '\\s*\\(').test(text),
        `${file} 仍有私有 ${name}()`)
    }
    assert.ok(!text.includes('navigator.clipboard.writeText'), `${file} 仍有裸剪贴板写入`)
  }
  for (const file of ['public/omm-hub.js', 'public/installer.js']) {
    assert.ok(!/function esc\s*\(/.test(read(file)), `${file} 仍有私有 esc()`)
  }
})

test('共享组件不再各自转义 HTML', () => {
  for (const file of ['dialog', 'menu', 'picker', 'select']) {
    const text = read(`public/zen/components/${file}.js`)
    assert.ok(!/function esc\s*\(/.test(text), `${file}.js 仍有私有 esc()`)
    assert.ok(text.includes('global.ZenUtil.esc'), `${file}.js 未引用 ZenUtil.esc`)
  }
  for (const page of ['public/omm-hub.html', 'public/installer.html']) {
    assert.ok(read(page).includes('src="zen/foundation/util.js"'),
      `${page} 未加载共享 util（共享组件的前置依赖）`)
  }
})

test('开关控件统一 ZenUI.switch，四种私有实现已删除', () => {
  for (const [page, owner] of [
    ['public/omm-hub.html', 'public/omm-hub.html'],
    ['public/omm-message.html', 'public/omm-message.html'],
    ['public/omm-redact.html', 'public/omm-redact.html'],
    ['public/installer.html', 'public/installer.js'],
  ]) {
    assert.ok(read(page).includes('zen/components/switch.js'), `${page} 未加载共享开关`)
    assert.ok(read(owner).includes('data-zen-switch'), `${owner} 未声明共享开关`)
  }
  for (const css of ['hub', 'installer', 'message', 'redact']) {
    const text = read(`public/zen/products/${css}.css`)
    assert.ok(!/\.toggle-switch\b|\.(?:cloud-)?switch(?:-track|\s*[,{:])/.test(text),
      `${css}.css 仍自带开关外观`)
  }
  const shared = read('public/zen/components/components.css')
  assert.ok(shared.includes('.switch-track'), '共享组件缺少开关外观')
})

test('快捷键说明面板统一 ZenUI.shortcuts.help', () => {
  const src = read('public/zen/components/shortcuts.js')
  for (const key of ['row', 'section', 'note', 'grid', 'parseRows', 'help']) {
    assert.ok(src.includes(key + ': ' + key) || src.includes('function ' + key + '('),
      `ZenUI.shortcuts 缺少 ${key}`)
  }
  const products = ['annotate', 'corpus', 'data', 'latex', 'redact',
    'visualization', 'message', 'writer']
  for (const id of products) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(text.includes('ZenUI.shortcuts.'), `${id} 未委托共享快捷键面板`)
    assert.ok(!text.includes('class="hk-row"'), `${id} 仍自带快捷键行标记`)
    assert.ok(!text.includes('class="hk-section"'), `${id} 仍自带快捷键分组标记`)
  }
})

test('作业运行时与画布端口几何来自共享库', () => {
  for (const id of ['table', 'video']) {
    assert.ok(read(`public/omm-${id}.html`).includes('src="lib/zen-job.js"'),
      `${id} 未加载共享作业运行时`)
    const lib = read(`public/lib/zen-${id}.js`)
    assert.ok(lib.includes('ZenJob.post('), `${id} 未委托 ZenJob.post`)
    assert.ok(lib.includes('ZenJob.cancel('), `${id} 未委托 ZenJob.cancel`)
    assert.ok(lib.includes('ZenJob.addAtCenter('), `${id} 未委托 ZenJob.addAtCenter`)
  }
  assert.ok(read('public/zen/canvas/engine.js').includes('getItemPort: getItemPort'),
    '画布引擎未导出通用端口几何')
  const writer = read('public/omm-writer.html')
  assert.ok(writer.includes('ZenCanvas.geometry.getItemPort'), 'Writer 未复用共享端口几何')
  assert.ok(!/const portOf = \(it, port\) => \{/.test(writer), 'Writer 仍有私有端口几何')
})

test('产品样式不再重复共享关键帧、云词汇与令牌', () => {
  for (const css of readdirSync(new URL('../public/zen/products/', import.meta.url))) {
    if (!css.endsWith('.css')) continue
    const text = read('public/zen/products/' + css)
    assert.ok(!/@keyframes\s+(?:spin|export-spin|vin)\b/.test(text), `${css} 仍重复共享关键帧`)
    assert.ok(!/--border-alpha\s*:/.test(text), `${css} 仍重复令牌`)
  }
  const message = read('public/zen/products/message.css')
  assert.ok(!/\.cloud-(?:status|field|label|input|help|note|actions|btn)\b/.test(message),
    'message.css 仍是 features/cloud.css 的私有副本')
  assert.ok(read('public/omm-message.html').includes('zen/features/cloud.css'),
    'Message 未加载共享云样式')
})

test('云同步面板与通用引擎统一到 ZenCloud', () => {
  const lib = read('public/lib/zen-cloud.js')
  assert.ok(lib.includes('global.ZenCloud ='), '共享云模块未暴露 ZenCloud')
  for (const key of ['panelHTML', 'footHTML', 'warnHTML', 'create']) {
    assert.ok(lib.includes('cloud.' + key + ' ='), `ZenCloud 缺少 ${key}`)
  }
  for (const id of ['annotate', 'corpus', 'data', 'english', 'planner', 'writer']) {
    const text = read(`public/omm-${id}.html`)
    assert.ok(text.includes('src="lib/zen-cloud.js"'), `${id} 未加载共享云模块`)
    assert.ok(text.includes('ZenCloud.panelHTML('), `${id} 未使用共享云面板`)
    assert.ok(text.includes('ZenCloud.create('), `${id} 未使用共享云引擎`)
    for (const fn of ['prefs', 'savePrefs', 'patchCfg', 'ensureWarnAck', 'openWarn', 'remote', 'isTableMissing', 'tpl']) {
      assert.ok(!new RegExp('function\\s+' + fn + '\\s*\\(').test(text),
        `${id} 仍有私有 ${fn}()`)
    }
    if (id !== 'writer') {
      assert.ok(!/function\s+friendly\s*\(/.test(text), `${id} 仍有私有 friendly()`)
      assert.ok(text.includes('var friendly = zenCloud.friendly'), `${id} 未委托共享错误分类`)
    }
    assert.ok(!/<template id="[^"]*(?:cloud|warn)-tpl"/.test(text),
      `${id} 仍自带云面板模版`)
  }
})

test('ZenCloud 的偏好、错误分类与面板标记在共享层可验证', () => {
  const store = new Map()
  const ctx = {
    ZenUtil: {
      esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
      getJSON: (key, fb) => (store.has(key) ? JSON.parse(store.get(key)) : fb),
      isTableMissing: (err) => !!(err && (err.code === 'PGRST205' ||
        /schema cache|Could not find the table/i.test(err.message || ''))),
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
    document: { getElementById: () => null },
    ZenUI: {
      modal: {
        open: () => ({ el: null }),
        close: () => {},
      },
      dialog: {
        confirm: () => Promise.resolve(true),
      },
    },
    setTimeout,
    Promise,
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(read('public/lib/zen-cloud.js'), ctx)
  const ZenCloud = ctx.ZenCloud
  const api = ZenCloud.create({
    prefix: 'zp',
    cfgKey: 'cfg',
    metaKey: 'meta',
    table: 'demo_sync',
    client: () => null,
    session: () => null,
    t: (key, fallback) => fallback,
  })
  const snap = () => JSON.stringify(api.prefs())
  assert.equal(snap(), JSON.stringify({ remember: false, autoSync: false, warnAck: false, password: '' }))
  api.savePrefs({ remember: true, password: 'pw', autoSync: true })
  assert.equal(snap(), JSON.stringify({ remember: true, autoSync: true, warnAck: false, password: 'pw' }))
  api.savePrefs({ remember: false })
  assert.equal(api.prefs().password, '')
  assert.equal(api.isTableMissing({ message: 'schema cache' }), true)
  assert.match(api.friendly({ message: 'Failed to fetch' }), /网络请求失败/)
  const warnHandle = api.openWarn()
  assert.equal(api.warnHandle(), warnHandle)
  const html = ZenCloud.panelHTML({ prefix: 'zw', sql: 'select 1' })
  assert.ok(html.includes('id="zw-sb-url"'))
  assert.ok(html.includes('id="zen-cloud-status"'))
  assert.ok(html.includes('select 1'))
  assert.ok(ZenCloud.warnHTML({ prefix: 'zw' }).includes('id="zw-warn-ok"'))
})

test('ZenCloud.remote 解包 Supabase 结果并向上传递 error', async () => {
  const store = new Map([['cfg', JSON.stringify({ url: 'https://demo.supabase.co/' })]])
  let result = { data: { payload: 'cipher', client_updated_at: 7 }, error: null }
  let query = null
  const client = {
    from(table) {
      assert.equal(table, 'demo_sync')
      query = {
        select(fields) { assert.equal(fields, 'payload,client_updated_at'); return this },
        eq(column, value) { assert.equal(column, 'user_id'); assert.equal(value, 'user-1'); return this },
        maybeSingle() { return Promise.resolve(result) },
      }
      return query
    },
  }
  const ctx = {
    ZenUtil: {
      esc: (s) => String(s), getJSON: (k, fb) => store.has(k) ? JSON.parse(store.get(k)) : fb,
      isTableMissing: () => false,
    },
    localStorage: {
      getItem: (k) => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    document: { getElementById: () => null },
    ZenUI: { modal: { open() {}, close() {} }, dialog: { confirm: () => Promise.resolve(true) } },
    Promise,
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(read('public/lib/zen-cloud.js'), ctx)
  const api = ctx.ZenCloud.create({
    cfgKey: 'cfg', metaKey: 'meta', table: 'demo_sync',
    client: () => client, session: () => ({ user: { id: 'user-1' } }),
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await api.remote())), { payload: 'cipher', client_updated_at: 7 })
  const error = { message: 'cloud failed' }
  result = { data: null, error }
  await assert.rejects(api.remote(), (e) => e === error)
})

test('ZenCloud 工作区按 project+user 隔离，切换需明确确认且重置基线', async () => {
  const store = new Map([['cfg', JSON.stringify({ url: 'https://one.supabase.co/' })]])
  const answers = []
  const ctx = {
    ZenUtil: {
      esc: (s) => String(s), getJSON: (k, fb) => store.has(k) ? JSON.parse(store.get(k)) : fb,
      isTableMissing: () => false,
    },
    localStorage: {
      getItem: (k) => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k),
    },
    document: { getElementById: () => null },
    ZenUI: {
      modal: { open() {}, close() {} },
      dialog: { confirm: (_body, opts) => { answers.push(opts); return Promise.resolve(answers.length > 1) } },
    },
    Promise,
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(read('public/lib/zen-cloud.js'), ctx)
  let user = 'u1'
  const api = ctx.ZenCloud.create({
    cfgKey: 'cfg', metaKey: 'meta', table: 'demo_sync', client: () => null, session: () => ({ user: { id: user } }),
  })
  api.mark(10, { syncedDocHash: 'old' })
  assert.equal(api.workspaceMeta('u1').updatedAt, 10)
  assert.equal(api.workspaceMeta('u2').updatedAt, undefined)
  assert.equal(api.workspaceNeedsConfirmation('u1'), false)
  user = 'u2'
  assert.equal(api.workspaceNeedsConfirmation('u2'), true)
  assert.equal(await api.confirmWorkspace('u2'), false)
  assert.equal(api.workspaceMeta('u2').updatedAt, undefined)
  assert.equal(await api.confirmWorkspace('u2'), true)
  assert.equal(api.workspaceMeta('u2').updatedAt, 0)
  assert.equal(api.workspaceMeta('u2').syncedDocHash, '')
  assert.equal(answers.length, 2)
  assert.equal(answers[0].danger, true)
})

test('ZenCSV 是 CSV/TSV 的唯一无损编解码器', () => {
  const ctx = { window: null }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(read('public/lib/zen-csv.js'), ctx)
  const rows = [['word', 'meaning'], ['a,b', 'say "hi"'], ['line\nbreak', ' padded '], ['', '制表符\t值']]
  for (const delimiter of [',', '\t']) {
    const encoded = ctx.ZenCSV.stringify(rows, delimiter)
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.ZenCSV.parse(encoded, delimiter))), rows)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.ZenCSV.parse('\uFEFFa,b\r\n"x,y","z""q"\r\n', ','))), [['a', 'b'], ['x,y', 'z"q']])
  assert.equal(ctx.ZenCSV.stringify([['=1+1']], ','), '=1+1\r\n')
  assert.equal(ctx.ZenCSV.stringify([['=1+1']], ',', { formulaSafe: true }), "'=1+1\r\n")
  assert.throws(() => ctx.ZenCSV.parse('a;b', ';'), /逗号或制表符/)
})
