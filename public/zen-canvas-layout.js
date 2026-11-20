/* zen-canvas-layout.js — Writer“所思所想”画布自动布局引擎（通用纯函数）
 * 本文件由 omm-writer.html 的 AUTO-LAYOUT CORE 区块原样抽取，逻辑未作改写。
 * Writer 与 ZenFlow 流程编辑器共同调用本模块，避免两处重复实现。
 *
 * 输入：nodes = [{ id, w, h, x0?, y0? }]
 *       conns = [{ from, to, fromPort?, toPort? }]
 * 输出：{ items: [{ id, x, y }], w, h, ports: { [连线key]: 端口修正 } }
 *
 * 既是浏览器 classic script（window.ZenCanvasLayout），也可在 Node 中 import
 * 后从 globalThis.ZenCanvasLayout 读取，方便单元测试直接验证纯函数。
 */
(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.ZenCanvasLayout = api
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict'

        function computeRadialOrTimeline(nodes, conns, mode, opt) {
          opt = opt || {}
          const sizeOf = new Map()
          nodes.forEach((n) =>
            sizeOf.set(n.id, {
              w: Math.max(1, n.w || 240),
              h: Math.max(1, n.h || 120),
            }),
          )
          const edges = []
          const seen = new Set()
          ;(conns || []).forEach((c) => {
            if (!c || !sizeOf.has(c.from) || !sizeOf.has(c.to) || c.from === c.to) return
            const k1 = c.from + '>' + c.to
            const k2 = c.to + '>' + c.from
            if (seen.has(k1) || seen.has(k2)) return
            seen.add(k1)
            edges.push([c.from, c.to])
          })
          const adj = new Map()
          nodes.forEach((n) => adj.set(n.id, []))
          edges.forEach((e) => {
            adj.get(e[0]).push(e[1])
            adj.get(e[1]).push(e[0])
          })
          // 连通块划分（多块互不相连）
          const comps = []
          const visited = new Set()
          nodes.forEach((n) => {
            if (visited.has(n.id)) return
            const comp = []
            const queue = [n.id]
            visited.add(n.id)
            while (queue.length) {
              const cur = queue.shift()
              comp.push(cur)
              adj.get(cur).forEach((nb) => {
                if (!visited.has(nb)) {
                  visited.add(nb)
                  queue.push(nb)
                }
              })
            }
            comps.push(comp)
          })
          const items = []
          // 环距/列距按节点尺寸自适应：环上相邻两节点沿径向的最小
          // 中心距 = 对角半径之和，不足必重叠
          let avgW = 0
          let avgH = 0
          nodes.forEach((n) => {
            const s = sizeOf.get(n.id)
            avgW += s.w
            avgH += s.h
          })
          avgW = nodes.length ? avgW / nodes.length : 240
          avgH = nodes.length ? avgH / nodes.length : 120
          const diagR = Math.sqrt((avgW / 2) * (avgW / 2) + (avgH / 2) * (avgH / 2))
          const GAP =
            mode === 'radial'
              ? Math.max(opt.ringGap || 160, diagR * 2 + 140)
              : Math.max(opt.colGap || 190, avgW + 110)
          // 连通块之间的流式排布：行宽超过 ~4200 换行
          let cx = 0
          let cy = 0
          let rowH = 0
          const ROW_W = 4200
          comps.forEach((comp) => {
            const pos = new Map()
            if (mode === 'radial') {
              // 环形：起点 = 块内度数最高的节点，同心环向外铺
              let center = comp[0]
              let bestDeg = -1
              comp.forEach((id) => {
                const d = adj.get(id).length
                if (d > bestDeg) {
                  bestDeg = d
                  center = id
                }
              })
              const levelOf = new Map([[center, 0]])
              const rings = [[center]]
              let queue = [center]
              while (queue.length) {
                const next = []
                queue.forEach((id) => {
                  adj.get(id).forEach((nb) => {
                    if (!levelOf.has(nb)) {
                      levelOf.set(nb, levelOf.get(id) + 1)
                      next.push(nb)
                    }
                  })
                })
                if (next.length) rings.push(next)
                queue = next
              }
              const cs = sizeOf.get(center)
              pos.set(center, { x: -cs.w / 2, y: -cs.h / 2 })
              rings.forEach((ring, lvl) => {
                if (lvl === 0) return
                // 多节点环自适应：弦距不足时增大半径（周长 ≥ 节点数 × 对角距）
                const r = Math.max(lvl * GAP, (diagR * 2 * ring.length * 1.35) / (2 * Math.PI))
                // 同环均分角度，避开 0°/90° 等正交方向（连线更顺）
                const offset = (lvl % 2) * (Math.PI / ring.length) + Math.PI / ring.length
                ring.forEach((id, i) => {
                  const ang = offset + (i * 2 * Math.PI) / ring.length
                  const s = sizeOf.get(id)
                  pos.set(id, {
                    x: Math.round(Math.cos(ang) * r - s.w / 2),
                    y: Math.round(Math.sin(ang) * r - s.h / 2),
                  })
                })
              })
            } else {
              // 时间线：BFS 层 = 从左到右的列，列内自上而下
              const levelOf = new Map()
              const cols = []
              // 每个未访问节点都可以作为一列的起点（多根）
              comp.forEach((id) => {
                if (levelOf.has(id)) return
                const queue = [id]
                levelOf.set(id, 0)
                while (queue.length) {
                  const cur = queue.shift()
                  ;(cols[levelOf.get(cur)] = cols[levelOf.get(cur)] || []).push(cur)
                  adj.get(cur).forEach((nb) => {
                    if (!levelOf.has(nb)) {
                      levelOf.set(nb, levelOf.get(cur) + 1)
                      queue.push(nb)
                    }
                  })
                }
              })
              let y = 0
              cols.forEach((col, lvl) => {
                const colW = Math.max.apply(
                  null,
                  col.map((id) => sizeOf.get(id).w),
                )
                let yy = y
                col.forEach((id) => {
                  const s = sizeOf.get(id)
                  pos.set(id, { x: Math.round(lvl * GAP), y: Math.round(yy) })
                  yy += s.h + 64
                })
                y = yy + 60
              })
            }
            // 块包围盒归一化到 (0,0)
            let mx = Infinity
            let my = Infinity
            let mw = -Infinity
            let mh = -Infinity
            pos.forEach((p, id) => {
              const s = sizeOf.get(id)
              mx = Math.min(mx, p.x)
              my = Math.min(my, p.y)
              mw = Math.max(mw, p.x + s.w)
              mh = Math.max(mh, p.y + s.h)
            })
            // 超宽换行
            if (cx > 0 && cx + (mw - mx) > ROW_W) {
              cx = 0
              cy += rowH + 160
              rowH = 0
            }
            pos.forEach((p, id) => {
              items.push({ id: id, x: Math.round(p.x - mx + cx), y: Math.round(p.y - my + cy) })
            })
            cx += mw - mx + 200
            rowH = Math.max(rowH, mh - my)
          })
          return { items: items, ports: {} }
        }

        function computeCanvasLayout(nodes, conns, opts) {
          const opt = opts || {}
          // 排布策略：'layered' 分层瀑布 / 'force' 力导向 / 'radial' 径向 /
          // 'timeline' 时间线（横向树）/ 'spine' 主线（长链居中 + 侧挂）/
          // 'smart'（默认：每块分别排一遍，按穿线、长度、紧凑度择优）
          const strategyMode =
            opt.strategy === 'force' ||
            opt.strategy === 'layered' ||
            opt.strategy === 'radial' ||
            opt.strategy === 'timeline' ||
            opt.strategy === 'spine'
              ? opt.strategy
              : 'smart'
          // 径向 / 时间线走独立轻量引擎，不进分层/力导向流水线；
          // 它们的收尾（解重叠 + 端口/折线）在 edges 建好之后统一做。
          const COL_GAP = opt.colGap || 56 // 层内相邻节点之间的水平净距
          const ROW_GAP = opt.rowGap || 76 // 相邻两层之间的垂直净距
          const COMP_GAP = opt.compGap || 150 // 互不相连的块之间的净距
          const DUMMY_W = 16 // 跨层连线在中间层占的通道宽度
          const DUMMY_H = 8
          const SWEEPS = 12 // 消交叉扫描轮数
          const REPAIRS = 14 // “复核—修复”轮数上限
          const SAFE = 6 // 复核时连线与节点之间至少留出的余量
          const SAMPLES = 56 // 每条连线采样段数
          const MAX_HALO = 640 // 单个节点最多额外撑开多少间距
          const MIN_GAP = Math.max(16, Math.round(COL_GAP * 0.4)) // 硬对齐时允许压到的最小净距

          const isVertPort = (p) => p === 'top' || p === 'bottom'
          const isHorzPort = (p) => p === 'left' || p === 'right'

          // 连线交叉计数（只数真正的相交，共用端点的线不算），供智能策略
          // 在“主线 / 分层 / 力导向”之间选出更少打结的一版。
          const crossingCount = (items, own, ports) => {
            const by = new Map(items.map((it) => [it.id, it]))
            const port = (it, p) => {
              const cx = it.x + it.w / 2
              const cy = it.y + it.h / 2
              if (p === 'top') return { x: cx, y: it.y }
              if (p === 'bottom') return { x: cx, y: it.y + it.h }
              if (p === 'left') return { x: it.x, y: cy }
              if (p === 'right') return { x: it.x + it.w, y: cy }
              return { x: cx, y: cy }
            }
            const segs = []
            own.forEach((e) => {
              const a = by.get(e.from)
              const b = by.get(e.to)
              if (!a || !b) return
              const fix = ports && ports[e.key]
              const fp = fix ? fix.fromPort : e.fromPort
              const tp = fix ? fix.toPort : e.toPort
              segs.push({ e: e, p1: port(a, fp), p2: port(b, tp) })
            })
            const cross = (p1, p2, p3, p4) => {
              const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
              const d1 = d(p3, p4, p1)
              const d2 = d(p3, p4, p2)
              const d3 = d(p1, p2, p3)
              const d4 = d(p1, p2, p4)
              return d1 * d2 < 0 && d3 * d4 < 0
            }
            let n = 0
            for (let i = 0; i < segs.length; i++) {
              for (let j = i + 1; j < segs.length; j++) {
                const a = segs[i]
                const b = segs[j]
                if (
                  a.e.from === b.e.from ||
                  a.e.from === b.e.to ||
                  a.e.to === b.e.from ||
                  a.e.to === b.e.to
                )
                  continue
                if (cross(a.p1, a.p2, b.p1, b.p2)) n++
              }
            }
            return n
          }

          // ---------- 0. 输入整理：节点尺寸、去重后的连线 ----------
          const nodeById = new Map()
          nodes.forEach((n, i) => {
            nodeById.set(n.id, {
              id: n.id,
              w: Math.max(1, n.w || 0),
              h: Math.max(1, n.h || 0),
              // 原坐标只用来判断“谁在谁左边 / 上面”以及侧边挂件的先后次序；
              // 排布结果不依赖它，读不到时退回节点数组顺序。
              ox: Number.isFinite(n.x0) ? n.x0 : null,
              oy: Number.isFinite(n.y0) ? n.y0 : null,
              ord: i,
            })
          })

          const edges = []
          const seenEdge = new Set()
          ;(conns || []).forEach((c) => {
            if (!c || !nodeById.has(c.from) || !nodeById.has(c.to) || c.from === c.to) return
            const fromPort = c.fromPort || 'bottom'
            const toPort = c.toPort || 'top'
            const key = c.from + '>' + c.to + ':' + fromPort + ':' + toPort
            if (seenEdge.has(key)) return
            seenEdge.add(key)
            edges.push({ key, from: c.from, to: c.to, fromPort, toPort })
          })

          if (strategyMode === 'radial' || strategyMode === 'timeline') {
            const res = computeRadialOrTimeline(nodes, conns, strategyMode, opt)
            return finalizeFreeLayout(res, edges)
          }

          // 端口定朝向：竖直型 V / 水平型 H / 拐弯型 M，
          // 并推断排布意义上的上下、左右两端（只看画法，不看箭头方向）。
          edges.forEach((e) => {
            const fv = isVertPort(e.fromPort)
            const tv = isVertPort(e.toPort)
            e.kind = fv && tv ? 'V' : !fv && !tv ? 'H' : 'M'
            if (e.kind === 'H') {
              if (e.fromPort === 'right' && e.toPort !== 'right') {
                e.left = e.from
                e.right = e.to
              } else if (e.toPort === 'right' && e.fromPort !== 'right') {
                e.left = e.to
                e.right = e.from
              } else if (e.fromPort === 'left') {
                e.left = e.to
                e.right = e.from
              } else {
                e.left = e.from
                e.right = e.to
              }
            } else {
              const vId = fv ? e.from : e.to
              const oId = fv ? e.to : e.from
              const vPort = fv ? e.fromPort : e.toPort
              // bottom（线从下面走）的一端在上；top 的一端在下
              e.up = vPort === 'top' ? oId : vId
              e.down = vPort === 'top' ? vId : oId
            }
          })

          // ---------- 1. 分块：互不相连的节点各成一块 ----------
          const adj = new Map()
          nodes.forEach((n) => adj.set(n.id, []))
          edges.forEach((e) => {
            adj.get(e.from).push(e.to)
            adj.get(e.to).push(e.from)
          })
          const comps = []
          const walked = new Set()
          nodes.forEach((n) => {
            if (walked.has(n.id)) return
            walked.add(n.id)
            const queue = [n.id]
            const ids = []
            while (queue.length) {
              const id = queue.shift()
              ids.push(id)
              adj.get(id).forEach((nb) => {
                if (walked.has(nb)) return
                walked.add(nb)
                queue.push(nb)
              })
            }
            comps.push(ids)
          })

          // ---------- 2. 逐块排布（策略可按块路由） ----------
          const blocks = comps.map((ids) => {
            const inB = new Set(ids)
            const blockEdges = edges.filter((e) => inB.has(e.from) && inB.has(e.to))
            const routed = (r) =>
              finalizeFreeLayout(r, blockEdges, {
                separate: false,
                keepClean: true,
                ports: r.ports,
              })
            let eCnt = 0
            edges.forEach((e) => {
              if (inB.has(e.from) && inB.has(e.to)) eCnt++
            })
            if (strategyMode === 'force') return routed(layoutBlockForce(ids))
            if (strategyMode === 'spine') {
              const rS = layoutBlockSpine(ids)
              // 没有一条足够长的主线（例如纯环/散点）就退回分层，不让用户
              // 选了一个方案却拿到空结果。
              return routed(rS || layoutBlock(ids))
            }
            if (strategyMode === 'layered' || ids.length <= 6) return routed(layoutBlock(ids))
            // smart：两种都排一遍，按“穿线 + 长度 + 空旷度”打分择优。
            // 分层擅长树/链/浅 DAG，力导向擅长稠密含环——不必猜，比一下。
            // 注意：排布会改写边对象（loose 标记、端口），第二种策略开跑前
            // 必须把现场恢复成原始输入，否则两者的结果互相污染。
            const inBEdges = edges.filter((e) => inB.has(e.from) && inB.has(e.to))
            const savedEdges = inBEdges.map((e) => ({
              e: e,
              fromPort: e.fromPort,
              toPort: e.toPort,
              loose: !!e.loose,
              up: e.up,
              down: e.down,
            }))
            const restoreEdges = () => {
              savedEdges.forEach((s2) => {
                s2.e.fromPort = s2.fromPort
                s2.e.toPort = s2.toPort
                s2.e.loose = s2.loose
                s2.e.up = s2.up
                s2.e.down = s2.down
              })
            }
            const nodeArea = ids.reduce((s2, id) => {
              const n2 = nodeById.get(id)
              return s2 + n2.w * n2.h
            }, 0)
            const score = (r) => {
              const spread = Math.max(0, (r.w * r.h) / Math.max(1, nodeArea) - 8)
              return r.vios * 100000 + (r.cross || 0) * 4000 + r.len * 0.2 + spread * 300
            }
            const rL = layoutBlock(ids)
            restoreEdges()
            const rF = layoutBlockForce(ids)
            restoreEdges()
            // 主线排布：长链 + 侧挂结构的最紧凑解，也参与智能择优。
            const rS = layoutBlockSpine(ids)
            let best = score(rF) < score(rL) ? rF : rL
            if (rS && score(rS) < score(best)) {
              best = rS
            } else {
              // 主线方案也会改写共享 edges 的端口/走向；若落选必须还原，
              // 否则 routed(best) 会拿着别的方案的 ports 与残留的边状态渲染。
              restoreEdges()
            }
            return routed(best)
          })
          blocks.sort((a, b) => b.w * b.h - a.w * a.h)
          const totalArea = blocks.reduce((s, b) => s + (b.w + COMP_GAP) * (b.h + COMP_GAP), 0)
          const maxBlockW = blocks.reduce((m, b) => Math.max(m, b.w), 0)
          const shelfW = Math.max(maxBlockW, Math.sqrt(totalArea) * 1.3)
          const positions = []
          const ports = {}
          let cursorX = 0
          let cursorY = 0
          let shelfH = 0
          blocks.forEach((b) => {
            if (cursorX > 0 && cursorX + b.w > shelfW) {
              cursorX = 0
              cursorY += shelfH + COMP_GAP
              shelfH = 0
            }
            b.items.forEach((it) => {
              positions.push({ id: it.id, x: it.x + cursorX, y: it.y + cursorY })
            })
            // 栅格路线是块内绝对坐标，随块一起平移。
            if (cursorX || cursorY) {
              Object.keys(b.ports || {}).forEach((key) => {
                const p = b.ports[key]
                if (!p || !p.hint || p.hint.v !== 'path') return
                p.hint = {
                  v: 'path',
                  ax: p.hint.ax + cursorX,
                  ay: p.hint.ay + cursorY,
                  pts: (p.hint.pts || []).map((pt) => [pt[0] + cursorX, pt[1] + cursorY]),
                }
              })
            }
            Object.assign(ports, b.ports)
            cursorX += b.w + COMP_GAP
            if (b.h > shelfH) shelfH = b.h
          })
          let outW = 0
          let outH = 0
          positions.forEach((p) => {
            const n = nodeById.get(p.id)
            if (!n) return
            if (p.x + n.w > outW) outW = p.x + n.w
            if (p.y + n.h > outH) outH = p.y + n.h
          })
          return { items: positions, w: outW, h: outH, ports: ports }

          // ================================================================
          // 单块排布：分层 → 行内定序 → 逐层定位 → 复核修复
          // ================================================================
          function layoutBlock(ids) {
            const inBlock = new Set(ids)
            const own = edges.filter((e) => inBlock.has(e.from) && inBlock.has(e.to))
            const itemOf = new Map()
            ids.forEach((id) => {
              const n = nodeById.get(id)
              itemOf.set(id, {
                key: id,
                id: id,
                real: true,
                w: n.w,
                h: n.h,
                row: 0,
                halo: 0,
                preds: [],
                succs: [],
              })
            })

            // 每个节点在本块里的连接数（判断“只连了一条线”的叶子和 1:1）
            const deg = new Map()
            ids.forEach((id) => deg.set(id, 0))
            own.forEach((e) => {
              deg.set(e.from, deg.get(e.from) + 1)
              deg.set(e.to, deg.get(e.to) + 1)
            })
            // 真实邻居表（不含虚拟通道），供“重心精修”把相连的点拉近
            const adjReal = new Map()
            ids.forEach((id) => adjReal.set(id, []))
            own.forEach((e) => {
              if (e.from === e.to) return
              adjReal.get(e.from).push(e.to)
              adjReal.get(e.to).push(e.from)
            })

            // 2.1 水平连线：一个节点在同一层里最多左右各一条，多余的、
            //     或者会串成环的先降级成普通连线，免得一行被挤成一大团。
            const hKeep = new Set()
            const hDeg = new Map()
            const uf = new Map()
            ids.forEach((id) => {
              hDeg.set(id, 0)
              uf.set(id, id)
            })
            const find = (x) => {
              while (uf.get(x) !== x) x = uf.get(x)
              return x
            }
            own.forEach((e) => {
              if (e.kind !== 'H') return
              if (hDeg.get(e.left) >= 2 || hDeg.get(e.right) >= 2) return
              if (find(e.left) === find(e.right)) return
              uf.set(find(e.left), find(e.right))
              hDeg.set(e.left, hDeg.get(e.left) + 1)
              hDeg.set(e.right, hDeg.get(e.right) + 1)
              hKeep.add(e)
            })
            const upDownEdges = []
            own.forEach((e) => {
              if (e.kind !== 'H' || hKeep.has(e)) return
              e.loose = true
              e.up = e.left
              e.down = e.right
            })
            own.forEach((e) => {
              if (e.kind !== 'H' || e.loose) upDownEdges.push(e)
            })

            // 2.2 分层：竖直连线按“上→下”做最长路径分层。端口互相打架
            //     形成环时，按入度最小的节点破环；被破的连线只画线，
            //     不参与分层（端点不互相约束）。
            const succAll = new Map()
            const predAll = new Map()
            const indeg = new Map()
            ids.forEach((id) => {
              succAll.set(id, [])
              predAll.set(id, [])
              indeg.set(id, 0)
            })
            upDownEdges.forEach((e) => {
              if (e.up === e.down) return
              succAll.get(e.up).push({ id: e.down, e: e })
              predAll.get(e.down).push({ id: e.up, e: e })
              indeg.set(e.down, indeg.get(e.down) + 1)
            })
            const rank = new Map()
            ids.forEach((id) => rank.set(id, 0))
            const cut = new Set()
            const rankDone = new Set()
            const queue = ids.filter((id) => indeg.get(id) === 0)
            let processed = 0
            while (processed < ids.length) {
              while (queue.length) {
                const u = queue.shift()
                if (rankDone.has(u)) continue
                rankDone.add(u)
                processed++
                succAll.get(u).forEach((link) => {
                  if (cut.has(link.e)) return
                  rank.set(link.id, Math.max(rank.get(link.id), rank.get(u) + 1))
                  indeg.set(link.id, indeg.get(link.id) - 1)
                  if (indeg.get(link.id) === 0) queue.push(link.id)
                })
              }
              if (processed >= ids.length) break
              let pick = null
              ids.forEach((id) => {
                if (rankDone.has(id) || indeg.get(id) <= 0) return
                if (pick === null || indeg.get(id) < indeg.get(pick)) pick = id
              })
              if (pick === null) break
              predAll.get(pick).forEach((link) => {
                if (cut.has(link.e) || rankDone.has(link.id)) return
                cut.add(link.e)
                indeg.set(pick, indeg.get(pick) - 1)
              })
              queue.push(pick)
            }

            // 2.3 水平连线要求两端同一层：把两端统一到较大的层号，
            //     再把这个层号往下传（层号只增不减，必然收敛）。
            //     若两端本身已经隔着一条有向路径（端口互相打架），
            //     同一层是登不上的，直接降级成普通连线。
            const bumpQueue = []
            const buildRankSucc = () => {
              const map = new Map()
              ids.forEach((id) => map.set(id, []))
              upDownEdges.forEach((e) => {
                if (e.up === e.down || cut.has(e)) return
                map.get(e.up).push(e.down)
              })
              return map
            }
            const reachable = (from, to) => {
              const seen = new Set([from])
              const stack = [from]
              while (stack.length) {
                const u = stack.pop()
                if (u === to) return true
                succAll.get(u).forEach((link) => {
                  if (cut.has(link.e) || seen.has(link.id)) return
                  seen.add(link.id)
                  stack.push(link.id)
                })
              }
              return false
            }
            hKeep.forEach((e) => {
              if (!reachable(e.left, e.right) && !reachable(e.right, e.left)) return
              hKeep.delete(e)
              e.loose = true
              // 端点之间有路径时，长在上游的那端才是排布意义上的“上面”
              if (reachable(e.right, e.left)) {
                e.up = e.right
                e.down = e.left
              } else {
                e.up = e.left
                e.down = e.right
              }
              upDownEdges.push(e)
            })
            let rankSucc = buildRankSucc()
            let bumpCount = 0
            const bump = (id, r) => {
              if (rank.get(id) >= r) return
              rank.set(id, r)
              bumpQueue.push(id)
            }
            const drain = () => {
              while (bumpQueue.length && bumpCount < ids.length * ids.length + 256) {
                bumpCount++
                const u = bumpQueue.shift()
                rankSucc.get(u).forEach((v) => bump(v, rank.get(u) + 1))
              }
              bumpQueue.length = 0
            }
            let hGuard = 0
            for (;;) {
              let changed = false
              hKeep.forEach((e) => {
                const a = rank.get(e.left)
                const b = rank.get(e.right)
                if (a === b) return
                const r = Math.max(a, b)
                bump(e.left, r)
                bump(e.right, r)
                changed = true
              })
              drain()
              if (!changed || hGuard++ > ids.length * 2 + 8) break
            }
            // 统一不上去的（极少数）降级成普通连线，交给复核与端口兜底
            hKeep.forEach((e) => {
              if (rank.get(e.left) === rank.get(e.right)) return
              hKeep.delete(e)
              e.loose = true
              if (reachable(e.right, e.left)) {
                e.up = e.right
                e.down = e.left
              } else {
                e.up = e.left
                e.down = e.right
              }
              upDownEdges.push(e)
            })
            rankSucc = buildRankSucc()
            bumpCount = 0
            upDownEdges.forEach((e) => {
              if (e.up === e.down) return
              bump(e.down, rank.get(e.up) + 1)
            })
            drain()

            // 2.4 行结构：真实节点按层入行，跨层连线在中间层插虚拟通道
            let maxRank = 0
            ids.forEach((id) => {
              const r = rank.get(id)
              itemOf.get(id).row = r
              if (r > maxRank) maxRank = r
            })
            const rows = []
            for (let r = 0; r <= maxRank; r++) rows.push([])
            ids.forEach((id) => rows[itemOf.get(id).row].push(itemOf.get(id)))
            let dummySeq = 0
            upDownEdges.forEach((e) => {
              // 破环被切的连线也插通道：它们正是稠密图里“横穿整个画布”的
              // 元凶——没有通道就不参与行内定序，自由飞行几千像素还压节点。
              // 给它们同样的通道后，定序扫描会把通道和真实节点排开。
              if (e.up === e.down) return
              const ru = rank.get(e.up)
              const rv = rank.get(e.down)
              if (rv <= ru) return
              let prev = itemOf.get(e.up)
              for (let r = ru + 1; r < rv; r++) {
                const dummy = {
                  key: '__d' + dummySeq++,
                  id: null,
                  real: false,
                  w: DUMMY_W,
                  h: DUMMY_H,
                  row: r,
                  halo: 0,
                  chain: e,
                  preds: [],
                  succs: [],
                }
                rows[r].push(dummy)
                dummy.preds.push(prev)
                prev.succs.push(dummy)
                prev = dummy
              }
              const tail = itemOf.get(e.down)
              tail.preds.push(prev)
              prev.succs.push(tail)
            })

            // 2.5 层内顺序：先按父节点位置铺下来，再中位数扫描 + 相邻交换
            //     消交叉，取交叉最少的一版。
            const median = (arr) => {
              if (!arr.length) return null
              const s = arr.slice().sort((a, b) => a - b)
              const m = s.length >> 1
              return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
            }
            rows.forEach((row) => row.forEach((it, i) => (it.pos = i)))
            for (let r = 1; r < rows.length; r++) {
              rows[r].forEach((it) => {
                it._k = it.preds.length
                  ? it.preds.reduce((s, p) => s + p.pos, 0) / it.preds.length
                  : it.pos
              })
              rows[r].sort((a, b) => a._k - b._k)
              rows[r].forEach((it, i) => (it.pos = i))
            }
            const sweep = (r, usePred) => {
              const row = rows[r]
              row.forEach((it) => {
                const nb = usePred ? it.preds : it.succs
                it._m = nb.length ? median(nb.map((p) => p.pos)) : null
              })
              row.sort((a, b) => (a._m === null ? a.pos : a._m) - (b._m === null ? b.pos : b._m))
              row.forEach((it, i) => (it.pos = i))
            }
            const countCross = () => {
              let total = 0
              for (let r = 0; r + 1 < rows.length; r++) {
                const pairs = []
                rows[r + 1].forEach((v) => v.preds.forEach((p) => pairs.push([p.pos, v.pos])))
                if (pairs.length < 2) continue
                pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1])
                const n = rows[r + 1].length + 1
                const bit = new Array(n + 1).fill(0)
                const add = (i) => {
                  for (i += 1; i <= n; i += i & -i) bit[i]++
                }
                const sum = (i) => {
                  let s = 0
                  for (i += 1; i > 0; i -= i & -i) s += bit[i]
                  return s
                }
                for (let i = pairs.length - 1; i >= 0; i--) {
                  total += sum(pairs[i][1] - 1)
                  add(pairs[i][1])
                }
              }
              return total
            }
            let bestRows = rows.map((row) => row.slice())
            let bestCross = countCross()
            for (let it = 0; it < SWEEPS && bestCross > 0; it++) {
              if (it % 2 === 0) for (let r = 1; r < rows.length; r++) sweep(r, true)
              else for (let r = rows.length - 2; r >= 0; r--) sweep(r, false)
              const c = countCross()
              if (c < bestCross) {
                bestCross = c
                bestRows = rows.map((row) => row.slice())
              }
            }
            rows.forEach((row, r) => {
              rows[r] = bestRows[r]
              rows[r].forEach((it, i) => (it.pos = i))
            })

            // 2.6 水平连线的两端在层内必须挨着，否则线会从别人身上穿过去；
            //     把每一簇水平连线的节点收拢成连续的一小段。
            const hPair = new Map()
            hKeep.forEach((e) => {
              const a = itemOf.get(e.left)
              const b = itemOf.get(e.right)
              if (!a || !b || a.row !== b.row) return
              if (!hPair.has(a.key)) hPair.set(a.key, [])
              if (!hPair.has(b.key)) hPair.set(b.key, [])
              hPair.get(a.key).push(b.key)
              hPair.get(b.key).push(a.key)
            })
            rows.forEach((row, r) => {
              if (row.length < 2) return
              const byKey = new Map(row.map((it) => [it.key, it]))
              const oldIdx = new Map(row.map((it, i) => [it.key, i]))
              const used = new Set()
              const next = []
              row.forEach((it) => {
                if (used.has(it.key)) return
                const partners = hPair.get(it.key)
                if (!partners || !partners.length) {
                  used.add(it.key)
                  next.push(it)
                  return
                }
                const cluster = []
                const stack = [it.key]
                used.add(it.key)
                while (stack.length) {
                  const k = stack.pop()
                  cluster.push(k)
                  ;(hPair.get(k) || []).forEach((nk) => {
                    if (used.has(nk)) return
                    used.add(nk)
                    stack.push(nk)
                  })
                }
                const inCluster = new Set(cluster)
                let head = cluster.find(
                  (k) => (hPair.get(k) || []).filter((nk) => inCluster.has(nk)).length <= 1,
                )
                if (head == null) head = cluster[0]
                const order = []
                const seen = new Set()
                let cur = head
                while (cur != null) {
                  order.push(cur)
                  seen.add(cur)
                  const nk = (hPair.get(cur) || []).find((k) => inCluster.has(k) && !seen.has(k))
                  cur = nk == null ? null : nk
                }
                if (
                  order.length > 1 &&
                  oldIdx.get(order[0]) > oldIdx.get(order[order.length - 1])
                ) {
                  order.reverse()
                }
                order.forEach((k) => next.push(byKey.get(k)))
              })
              rows[r] = next
              rows[r].forEach((it, i) => (it.pos = i))
            })

            // 分层流水线到此结束，收尾（行高/求解/精修/复核/端口优化）交给
            // 与力导向策略共用的 finishBlock。
            return finishBlock({
              rows: rows,
              own: own,
              itemOf: itemOf,
              deg: deg,
              adjReal: adjReal,
              hPair: hPair,
              cut: cut,
              canPin: true,
              useMirror: true,
            })
          }

          // ================================================================
          // 自由布局收尾（径向 / 时间线共用）：
          // 1) 先用真实尺寸把重叠的节点推开（保证两两不重叠）；
          // 2) 每条连线按几何挑最顺的端口，曲线仍压节点/自穿时改画
          //    横平竖直的折线兜底，和分层/力导向用的是同一套走线。
          // ================================================================
          function finalizeFreeLayout(res, own, opts) {
            const opt = opts || {}
            const separate = opt.separate !== false
            const keepClean = !!opt.keepClean
            const previous = opt.ports || res.ports || {}
            const arr = res.items.map((it) => {
              const n = nodeById.get(it.id)
              return { id: it.id, x: it.x, y: it.y, w: n.w, h: n.h }
            })
            // ---- 1. 矩形解重叠：沿穿透较浅的轴对半推开 ----
            if (separate) {
              for (let round = 0; round < 120; round++) {
                let moved = false
                for (let i = 0; i < arr.length; i++) {
                  for (let j = i + 1; j < arr.length; j++) {
                    const a = arr[i]
                    const b = arr[j]
                    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
                    const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
                    if (ix <= 0 || iy <= 0) continue
                    if (ix < iy) {
                      const d = ix / 2 + 2
                      if (a.x + a.w / 2 <= b.x + b.w / 2) {
                        a.x -= d
                        b.x += d
                      } else {
                        a.x += d
                        b.x -= d
                      }
                    } else {
                      const d = iy / 2 + 2
                      if (a.y + a.h / 2 <= b.y + b.h / 2) {
                        a.y -= d
                        b.y += d
                      } else {
                        a.y += d
                        b.y -= d
                      }
                    }
                    moved = true
                  }
                }
                if (!moved) break
              }
            }

            // ---- 2. 端口与折线：曲线采样 / 折线采样 / 罚分 ----
            const SAFE = 4
            const samplePort = (it, port) => {
              const cx = it.x + it.w / 2
              const cy = it.y + it.h / 2
              if (port === 'top') return { x: cx, y: it.y }
              if (port === 'bottom') return { x: cx, y: it.y + it.h }
              if (port === 'left') return { x: it.x, y: cy }
              if (port === 'right') return { x: it.x + it.w, y: cy }
              return { x: cx, y: cy }
            }
            const sampleCurve = (p1, p2, fp, tp, n) => {
              const dx = p2.x - p1.x
              const dy = p2.y - p1.y
              const h1 = !isVertPort(fp)
              const h2 = !isVertPort(tp)
              let c1x = p1.x
              let c1y = p1.y
              let c2x = p2.x
              let c2y = p2.y
              if (h1 && h2) {
                const mid = (p1.x + p2.x) / 2
                c1x = mid
                c1y = p1.y
                c2x = mid
                c2y = p2.y
              } else if (!h1 && !h2) {
                const mid = (p1.y + p2.y) / 2
                c1x = p1.x
                c1y = mid
                c2x = p2.x
                c2y = mid
              } else if (h1) {
                c1x = p1.x
                c1y = p1.y + dy * 0.5
                c2x = p1.x + dx * 0.5
                c2y = p2.y
              } else {
                c1x = p1.x + dx * 0.5
                c1y = p1.y
                c2x = p2.x
                c2y = p1.y + dy * 0.5
              }
              const pts = []
              const S = n || 64
              for (let i = 0; i <= S; i++) {
                const t = i / S
                const u = 1 - t
                pts.push({
                  x: u * u * u * p1.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p2.x,
                  y: u * u * u * p1.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * p2.y,
                })
              }
              return pts
            }
            const PORT_DIR = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }
            const elbowSample = (a, b, fp, tp, v, k) => {
              const p1 = samplePort(a, fp)
              const p2 = samplePort(b, tp)
              const d1 = PORT_DIR[fp]
              const d2 = PORT_DIR[tp]
              const box = {
                x0: Math.min(a.x, b.x),
                y0: Math.min(a.y, b.y),
                x1: Math.max(a.x + a.w, b.x + b.w),
                y1: Math.max(a.y + a.h, b.y + b.h),
              }
              const stub = 26 * (1 + k * 0.6)
              const s1 = { x: p1.x + d1[0] * stub, y: p1.y + d1[1] * stub }
              const s2 = { x: p2.x + d2[0] * stub, y: p2.y + d2[1] * stub }
              const v1 = d1[1] !== 0
              const v2 = d2[1] !== 0
              const laneT = k === 1 ? 0.25 : k === 2 ? 0.75 : k === 3 ? 1.3 : k === 4 ? -0.3 : k === 5 ? 1.6 : k === 6 ? -0.6 : 0.5
              let wps
              if (v === 'lane' && v1 && v2) {
                const lane = s1.y + (s2.y - s1.y) * laneT
                wps = [p1, s1, { x: s1.x, y: lane }, { x: s2.x, y: lane }, s2, p2]
              } else if (v === 'lane' && !v1 && !v2) {
                const lane = s1.x + (s2.x - s1.x) * laneT
                wps = [p1, s1, { x: lane, y: s1.y }, { x: lane, y: s2.y }, s2, p2]
              } else if (v === 'aroundL' || v === 'aroundR') {
                const m = stub + 30 + k * 70
                if (v1 && v2) {
                  const laneX = v === 'aroundL' ? box.x0 - m : box.x1 + m
                  wps = [p1, s1, { x: laneX, y: s1.y }, { x: laneX, y: s2.y }, s2, p2]
                } else if (!v1 && !v2) {
                  const laneY = v === 'aroundL' ? box.y0 - m : box.y1 + m
                  wps = [p1, s1, { x: s1.x, y: laneY }, { x: s2.x, y: laneY }, s2, p2]
                } else {
                  const cx = v === 'aroundL' ? box.x0 - m : box.x1 + m
                  const cy = v === 'aroundL' ? box.y0 - m : box.y1 + m
                  wps = v1
                    ? [p1, s1, { x: s1.x, y: cy }, { x: cx, y: cy }, { x: cx, y: s2.y }, s2, p2]
                    : [p1, s1, { x: cx, y: s1.y }, { x: cx, y: cy }, { x: s2.x, y: cy }, s2, p2]
                }
              } else if (v === 'L') {
                if (v1 && !v2) wps = [p1, s1, { x: s2.x, y: s1.y }, s2, p2]
                else if (!v1 && v2) wps = [p1, s1, { x: s1.x, y: s2.y }, s2, p2]
                else if (v1 && v2) {
                  const lane = (s1.y + s2.y) / 2
                  wps = [p1, s1, { x: s1.x, y: lane }, { x: s2.x, y: lane }, s2, p2]
                } else {
                  const lane = (s1.x + s2.x) / 2
                  wps = [p1, s1, { x: lane, y: s1.y }, { x: lane, y: s2.y }, s2, p2]
                }
              } else {
                wps = [p1, p2]
              }
              const pts = []
              for (let i = 0; i + 1 < wps.length; i++) {
                const A = wps[i]
                const B = wps[i + 1]
                const d = Math.hypot(B.x - A.x, B.y - A.y)
                const n = Math.max(1, Math.round(d / 8))
                for (let j = 0; j < n; j++) {
                  pts.push({ x: A.x + ((B.x - A.x) * j) / n, y: A.y + ((B.y - A.y) * j) / n })
                }
              }
              pts.push(wps[wps.length - 1])
              return pts
            }
            // 正交栅格兜底：在节点边界构成的网格上做 A*，给仍然压节点的
            // 连线找一条真正绕开所有节点的横平竖直路线。hint 记住路线点，
            // 渲染端按“源端口位移”整体平移，节点拖动后仍跟随。
            const gridRoute = (a, b, fp, tp, placedMap) => {
              const p1 = samplePort(a, fp)
              const p2 = samplePort(b, tp)
              const d1 = PORT_DIR[fp]
              const d2 = PORT_DIR[tp]
              const M = 10
              const ob = []
              placedMap.forEach((it) => {
                ob.push({
                  x0: it.x - M,
                  y0: it.y - M,
                  x1: it.x + it.w + M,
                  y1: it.y + it.h + M,
                })
              })
              const inside = (x, y, o) => x > o.x0 && x < o.x1 && y > o.y0 && y < o.y1
              const inAny = (x, y) => {
                for (let i = 0; i < ob.length; i++) if (inside(x, y, ob[i])) return true
                return false
              }
              const segBlocked = (x1, y1, x2, y2) => {
                for (let i = 0; i < ob.length; i++) {
                  const o = ob[i]
                  if (x1 === x2) {
                    if (x1 > o.x0 && x1 < o.x1 && Math.max(y1, y2) > o.y0 && Math.min(y1, y2) < o.y1)
                      return true
                  } else if (
                    y1 > o.y0 &&
                    y1 < o.y1 &&
                    Math.max(x1, x2) > o.x0 &&
                    Math.min(x1, x2) < o.x1
                  )
                    return true
                }
                return false
              }
              const stubs = [26, 54, 88, 130]
              for (let si = 0; si < stubs.length; si++) {
                const stub = stubs[si]
                const s1 = { x: p1.x + d1[0] * stub, y: p1.y + d1[1] * stub }
                const s2 = { x: p2.x + d2[0] * stub, y: p2.y + d2[1] * stub }
                if (inAny(s1.x, s1.y) || inAny(s2.x, s2.y)) continue
                const xsSet = new Set([s1.x, s2.x])
                const ysSet = new Set([s1.y, s2.y])
                ob.forEach((o) => {
                  xsSet.add(o.x0)
                  xsSet.add(o.x1)
                  ysSet.add(o.y0)
                  ysSet.add(o.y1)
                })
                const compact = (arr) => {
                  const vals = Array.from(arr).sort((u, v) => u - v)
                  const out = []
                  vals.forEach((v) => {
                    if (!out.length || Math.abs(v - out[out.length - 1]) > 0.5) out.push(v)
                  })
                  return out
                }
                const gx = compact(xsSet)
                const gy = compact(ysSet)
                const nx = gx.length
                const ny = gy.length
                const nearest = (arr, v) =>
                  arr.reduce((bi, x, i) => (Math.abs(x - v) < Math.abs(arr[bi] - v) ? i : bi), 0)
                const startIx = gx.indexOf(s1.x) >= 0 ? gx.indexOf(s1.x) : nearest(gx, s1.x)
                const startIy = gy.indexOf(s1.y) >= 0 ? gy.indexOf(s1.y) : nearest(gy, s1.y)
                const goalIx = gx.indexOf(s2.x) >= 0 ? gx.indexOf(s2.x) : nearest(gx, s2.x)
                const goalIy = gy.indexOf(s2.y) >= 0 ? gy.indexOf(s2.y) : nearest(gy, s2.y)
                const total = nx * ny
                const dist = new Float64Array(total).fill(Infinity)
                const prev = new Int32Array(total).fill(-1)
                const start = startIy * nx + startIx
                const goal = goalIy * nx + goalIx
                dist[start] = 0
                const heap = [{ idx: start, f: 0 }]
                const push = (item) => {
                  heap.push(item)
                  let i = heap.length - 1
                  while (i > 0) {
                    const p = (i - 1) >> 1
                    if (heap[p].f <= heap[i].f) break
                    const t = heap[p]
                    heap[p] = heap[i]
                    heap[i] = t
                    i = p
                  }
                }
                const pop = () => {
                  const top = heap[0]
                  const last = heap.pop()
                  if (heap.length) {
                    heap[0] = last
                    let i = 0
                    for (;;) {
                      const l = i * 2 + 1
                      const r = l + 1
                      let m = i
                      if (l < heap.length && heap[l].f < heap[m].f) m = l
                      if (r < heap.length && heap[r].f < heap[m].f) m = r
                      if (m === i) break
                      const t = heap[m]
                      heap[m] = heap[i]
                      heap[i] = t
                      i = m
                    }
                  }
                  return top
                }
                let found = false
                let guard = 0
                while (heap.length && guard++ < total * 4) {
                  const cur = pop()
                  if (cur.idx === goal) {
                    found = true
                    break
                  }
                  if (cur.f - dist[cur.idx] > 1e-6) continue
                  const cx = cur.idx % nx
                  const cy = (cur.idx - cx) / nx
                  const around = [
                    [cx - 1, cy],
                    [cx + 1, cy],
                    [cx, cy - 1],
                    [cx, cy + 1],
                  ]
                  for (let k = 0; k < 4; k++) {
                    const ix = around[k][0]
                    const iy = around[k][1]
                    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue
                    const ni = iy * nx + ix
                    const X = gx[ix]
                    const Y = gy[iy]
                    if (segBlocked(gx[cx], gy[cy], X, Y)) continue
                    const g = dist[cur.idx] + Math.abs(X - gx[cx]) + Math.abs(Y - gy[cy])
                    if (g >= dist[ni] - 1e-6) continue
                    dist[ni] = g
                    prev[ni] = cur.idx
                    const h = Math.abs(X - gx[goalIx]) + Math.abs(Y - gy[goalIy])
                    push({ idx: ni, f: g + h })
                  }
                }
                if (!found) continue
                const ids = []
                for (let cur = goal; cur >= 0; cur = prev[cur]) {
                  ids.push(cur)
                  if (cur === start) break
                }
                ids.reverse()
                const raw = ids.map((idx) => {
                  const ix = idx % nx
                  const iy = (idx - ix) / nx
                  return { x: gx[ix], y: gy[iy] }
                })
                const simp = []
                raw.forEach((p, i) => {
                  if (i === 0 || i === raw.length - 1) {
                    simp.push(p)
                    return
                  }
                  const q = simp[simp.length - 1]
                  const r = raw[i + 1]
                  const straight =
                    (Math.abs(p.x - q.x) < 0.5 && Math.abs(r.x - p.x) < 0.5) ||
                    (Math.abs(p.y - q.y) < 0.5 && Math.abs(r.y - p.y) < 0.5)
                  if (!straight) simp.push(p)
                })
                const wps = [p1, ...simp, p2]
                const full = []
                for (let i = 0; i + 1 < wps.length; i++) {
                  const A = wps[i]
                  const B = wps[i + 1]
                  const d = Math.hypot(B.x - A.x, B.y - A.y)
                  const n = Math.max(1, Math.round(d / 8))
                  for (let j = 0; j < n; j++) {
                    full.push({ x: A.x + ((B.x - A.x) * j) / n, y: A.y + ((B.y - A.y) * j) / n })
                  }
                }
                full.push(wps[wps.length - 1])
                return {
                  pts: full,
                  hint: {
                    v: 'path',
                    ax: p1.x,
                    ay: p1.y,
                    pts: simp.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
                  },
                }
              }
              return null
            }

            const segRect = (x1, y1, x2, y2, x0, y0, x3, y3) => {
              let t0 = 0
              let t1 = 1
              const dx = x2 - x1
              const dy = y2 - y1
              const p = [-dx, dx, -dy, dy]
              const q = [x1 - x0, x3 - x1, y1 - y0, y3 - y1]
              for (let i = 0; i < 4; i++) {
                if (Math.abs(p[i]) < 1e-9) {
                  if (q[i] < 0) return false
                  continue
                }
                const t = q[i] / p[i]
                if (p[i] < 0) {
                  if (t > t1) return false
                  if (t > t0) t0 = t
                } else {
                  if (t < t0) return false
                  if (t < t1) t1 = t
                }
              }
              return true
            }
            const score = (pts, a, b, placedMap) => {
              const hit = new Set()
              let self = false
              // 其他节点：整段线段与节点矩形相交即算压到（不靠采样点碰运气）
              for (let i = 0; i + 1 < pts.length; i++) {
                const p = pts[i]
                const q = pts[i + 1]
                placedMap.forEach((it) => {
                  if (it === a || it === b) return
                  if (segRect(p.x, p.y, q.x, q.y, it.x - SAFE, it.y - SAFE, it.x + it.w + SAFE, it.y + it.h + SAFE))
                    hit.add(it.id)
                })
              }
              // 端点自身：采样仍然够用（线从自己的端口出来）
              for (let i = 2; i < pts.length - 2; i++) {
                const p = pts[i]
                placedMap.forEach((it) => {
                  if (it !== a && it !== b) return
                  if (p.x <= it.x + SAFE || p.x >= it.x + it.w - SAFE) return
                  if (p.y <= it.y + SAFE || p.y >= it.y + it.h - SAFE) return
                  self = true
                })
              }
              let len = 0
              for (let i = 1; i < pts.length; i++) {
                len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
              }
              return { pen: hit.size + (self ? 2 : 0), len: len }
            }
            const ALL_PORTS = ['top', 'bottom', 'left', 'right']
            const routeNow = (placedMap) => {
              const ports = {}
              let vios = 0
              own.forEach((e) => {
                const a = placedMap.get(e.from)
                const b = placedMap.get(e.to)
                if (!a || !b) return
                // 已经干净的端口/折线原样保留，只有真正压到节点的才重算。
                const prev = previous[e.key]
                if (keepClean && prev) {
                  let pts
                  if (prev.route === 'elbow' && prev.hint && prev.hint.v === 'path') {
                    const dx = samplePort(a, prev.fromPort).x - (prev.hint.ax || 0)
                    const dy = samplePort(a, prev.fromPort).y - (prev.hint.ay || 0)
                    const wps = [
                      samplePort(a, prev.fromPort),
                      ...(prev.hint.pts || []).map((pt) => ({ x: pt[0] + dx, y: pt[1] + dy })),
                      samplePort(b, prev.toPort),
                    ]
                    pts = []
                    for (let i = 0; i + 1 < wps.length; i++) {
                      const A = wps[i]
                      const B = wps[i + 1]
                      const d = Math.hypot(B.x - A.x, B.y - A.y)
                      const n = Math.max(1, Math.round(d / 8))
                      for (let j = 0; j < n; j++) {
                        pts.push({ x: A.x + ((B.x - A.x) * j) / n, y: A.y + ((B.y - A.y) * j) / n })
                      }
                    }
                    pts.push(wps[wps.length - 1])
                  } else if (prev.route === 'elbow' && prev.hint) {
                    pts = elbowSample(a, b, prev.fromPort, prev.toPort, prev.hint.v, prev.hint.k)
                  } else {
                    pts = sampleCurve(
                      samplePort(a, prev.fromPort),
                      samplePort(b, prev.toPort),
                      prev.fromPort,
                      prev.toPort,
                    )
                  }
                  if (score(pts, a, b, placedMap).pen === 0) {
                    ports[e.key] = prev
                    return
                  }
                }
              const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0
              const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0
              let natural
              if (yOverlap && !xOverlap) {
                natural = a.x < b.x ? ['right', 'left'] : ['left', 'right']
              } else {
                natural = a.y < b.y ? ['bottom', 'top'] : ['top', 'bottom']
              }
              const candidates = [natural, [e.fromPort, e.toPort]]
              ALL_PORTS.forEach((fp) => ALL_PORTS.forEach((tp) => candidates.push([fp, tp])))
              let best = null
              candidates.forEach(([fp, tp]) => {
                const r = score(sampleCurve(samplePort(a, fp), samplePort(b, tp), fp, tp), a, b, placedMap)
                if (!best || r.pen < best.pen || (r.pen === best.pen && r.len < best.len - 1)) {
                  best = { fp, tp, pen: r.pen, len: r.len, route: null, hint: null }
                }
              })
              if (best.pen > 0) {
                const v1 = isVertPort(best.fp)
                const v2 = isVertPort(best.tp)
                const combos =
                  v1 === v2
                    ? [
                        ['lane', 0],
                        ['lane', 1],
                        ['lane', 2],
                        ['lane', 3],
                        ['lane', 4],
                        ['lane', 5],
                        ['lane', 6],
                        ['aroundL', 0],
                        ['aroundR', 0],
                        ['aroundL', 1],
                        ['aroundL', 2],
                        ['aroundR', 1],
                        ['aroundR', 2],
                        ['aroundL', 3],
                        ['aroundR', 3],
                        ['aroundL', 4],
                        ['aroundR', 4],
                      ]
                    : [
                        ['L', 0],
                        ['L', 1],
                        ['L', 2],
                        ['aroundL', 0],
                        ['aroundR', 0],
                        ['aroundL', 1],
                        ['aroundL', 2],
                        ['aroundR', 1],
                        ['aroundR', 2],
                        ['aroundL', 3],
                        ['aroundR', 3],
                        ['aroundL', 4],
                        ['aroundR', 4],
                      ]
                const pairs = [
                  [best.fp, best.tp],
                  ['bottom', 'top'],
                  ['right', 'left'],
                  ['top', 'bottom'],
                  ['left', 'right'],
                ]
                pairs.forEach(([fp, tp]) => {
                  combos.forEach(([v, k]) => {
                    const r = score(elbowSample(a, b, fp, tp, v, k), a, b, placedMap)
                    if (r.pen < best.pen || (r.pen === best.pen && r.len < best.len - 1)) {
                      best = { fp, tp, pen: r.pen, len: r.len, route: 'elbow', hint: { v, k } }
                    }
                  })
                })
              }
              // 还压着节点：上正交栅格 A*，绕开所有节点。
              if (best.pen > 0) {
                const routed = gridRoute(a, b, best.fp, best.tp, placedMap)
                if (routed) {
                  const r = score(routed.pts, a, b, placedMap)
                  if (r.pen < best.pen) {
                    best = {
                      fp: best.fp,
                      tp: best.tp,
                      pen: r.pen,
                      len: r.len,
                      route: 'elbow',
                      hint: routed.hint,
                    }
                  }
                }
              }
              vios += best.pen
              if (best.route) {
                ports[e.key] = {
                  fromPort: best.fp,
                  toPort: best.tp,
                  route: 'elbow',
                  hint: best.hint,
                }
              } else {
                ports[e.key] = { fromPort: best.fp, toPort: best.tp }
              }
              })
              return { ports, vios }
            }

            // 收口：先按原坐标走线；仍有压线时把节点位置整体撑开
            // （尺寸不变、空隙变大）再试，取压线最少的一版。
            let placedMap = new Map()
            arr.forEach((it) => placedMap.set(it.id, it))
            let bestRoute = routeNow(placedMap)
            let bestArr = arr.map((it) => ({ ...it }))
            for (let s = 0; s < 3 && bestRoute.vios > 0; s++) {
              let ax0 = Infinity
              let ay0 = Infinity
              let ax1 = -Infinity
              let ay1 = -Infinity
              arr.forEach((it) => {
                ax0 = Math.min(ax0, it.x)
                ay0 = Math.min(ay0, it.y)
                ax1 = Math.max(ax1, it.x + it.w)
                ay1 = Math.max(ay1, it.y + it.h)
              })
              const acx = (ax0 + ax1) / 2
              const acy = (ay0 + ay1) / 2
              arr.forEach((it) => {
                it.x = acx + (it.x - acx) * 1.22
                it.y = acy + (it.y - acy) * 1.22
              })
              placedMap = new Map()
              arr.forEach((it) => placedMap.set(it.id, it))
              const r = routeNow(placedMap)
              if (r.vios < bestRoute.vios) {
                bestRoute = r
                bestArr = arr.map((it) => ({ ...it }))
              }
            }
            let fminX = Infinity
            let fminY = Infinity
            let fmaxX = -Infinity
            let fmaxY = -Infinity
            bestArr.forEach((it) => {
              fminX = Math.min(fminX, it.x)
              fminY = Math.min(fminY, it.y)
              fmaxX = Math.max(fmaxX, it.x + it.w)
              fmaxY = Math.max(fmaxY, it.y + it.h)
            })
            if (!isFinite(fminX)) {
              fminX = 0
              fminY = 0
              fmaxX = 0
              fmaxY = 0
            }
            // 栅格路线的坐标是布局时的绝对点，输出前跟着平移到 (0,0)。
            Object.keys(bestRoute.ports).forEach((key) => {
              const p = bestRoute.ports[key]
              if (!p || !p.hint || p.hint.v !== 'path') return
              p.hint = {
                v: 'path',
                ax: p.hint.ax - fminX,
                ay: p.hint.ay - fminY,
                pts: (p.hint.pts || []).map((pt) => [pt[0] - fminX, pt[1] - fminY]),
              }
            })
            return {
              items: bestArr.map((it) => ({
                id: it.id,
                x: Math.round(it.x - fminX),
                y: Math.round(it.y - fminY),
              })),
              w: fmaxX - fminX,
              h: fmaxY - fminY,
              ports: bestRoute.ports,
              vios: bestRoute.vios,
              cross: crossingCount(
                bestArr.map((it) => ({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h })),
                own,
                bestRoute.ports,
              ),
            }
          }

          // ================================================================
          // 单块排布·主线（spine）：先读真实尺寸，再找最长的一条竖直主线。
          // 主线节点按同一中轴一列排开（节点宽度可以各不相同）；其余节点
          // 作为“侧挂件”挂到主线的锚点上，左右各一条货架，同一锚点的挂
          // 件竖向等距堆叠、整体与锚点居中对齐，挂件还能再向外侧挂（如
          // 图 9 → 10）。大图不会被塞进同一行，主流程保持一条直线，所有
          // 连线都是短的水平/垂直线段，天然不压节点。
          // ================================================================
          function layoutBlockSpine(ids) {
            if (ids.length < 4) return null
            const inBlock = new Set(ids)
            const own = edges.filter((e) => inBlock.has(e.from) && inBlock.has(e.to))
            const nodeOf = (id) => nodeById.get(id)
            const upDown = (e) => {
              if (!isVertPort(e.fromPort) || !isVertPort(e.toPort)) return null
              const fromUp = e.fromPort === 'bottom' || e.toPort === 'top'
              const up = fromUp ? e.from : e.to
              const down = fromUp ? e.to : e.from
              return up === down ? null : { up, down }
            }
            const vedges = []
            own.forEach((e) => {
              const ud = upDown(e)
              if (ud) vedges.push(ud)
            })

            // ---- 1. 按竖直连线做最长路径分层（环边就地破开） ----
            const succ = new Map(ids.map((id) => [id, []]))
            const pred = new Map(ids.map((id) => [id, []]))
            const indeg = new Map(ids.map((id) => [id, 0]))
            vedges.forEach(({ up, down }) => {
              succ.get(up).push(down)
              pred.get(down).push(up)
              indeg.set(down, indeg.get(down) + 1)
            })
            const rank = new Map(ids.map((id) => [id, 0]))
            const done = new Set()
            const order = []
            const queue = ids.filter((id) => indeg.get(id) === 0)
            while (order.length < ids.length) {
              while (queue.length) {
                const u = queue.shift()
                if (done.has(u)) continue
                done.add(u)
                order.push(u)
                succ.get(u).forEach((v) => {
                  rank.set(v, Math.max(rank.get(v), rank.get(u) + 1))
                  indeg.set(v, indeg.get(v) - 1)
                  if (indeg.get(v) === 0) queue.push(v)
                })
              }
              if (order.length >= ids.length) break
              let pick = null
              ids.forEach((id) => {
                if (done.has(id)) return
                if (pick === null || indeg.get(id) < indeg.get(pick)) pick = id
              })
              if (pick === null) break
              pred.get(pick).forEach((u) => {
                if (done.has(u)) return
                indeg.set(pick, Math.max(0, indeg.get(pick) - 1))
              })
              indeg.set(pick, 0)
              queue.push(pick)
            }

            // ---- 2. 主线 = 最长关键路径（同长时取总高度更大的一条） ----
            const depth = new Map(ids.map((id) => [id, 1]))
            const weight = new Map(ids.map((id) => [id, nodeOf(id).h]))
            const prev = new Map(ids.map((id) => [id, null]))
            order.forEach((u) => {
              succ.get(u).forEach((v) => {
                if (!done.has(v)) return
                const d = depth.get(u) + 1
                const w = weight.get(u) + nodeOf(v).h
                if (d > depth.get(v) || (d === depth.get(v) && w > weight.get(v))) {
                  depth.set(v, d)
                  weight.set(v, w)
                  prev.set(v, u)
                }
              })
            })
            let tail = null
            ids.forEach((id) => {
              if (tail === null) {
                tail = id
                return
              }
              if (
                depth.get(id) > depth.get(tail) ||
                (depth.get(id) === depth.get(tail) && weight.get(id) > weight.get(tail))
              )
                tail = id
            })
            const spine = []
            for (let cur = tail; cur != null; cur = prev.get(cur)) spine.unshift(cur)
            if (spine.length < 3) return null
            const spineSet = new Set(spine)
            const spineIdx = new Map(spine.map((id, i) => [id, i]))
            const rankSpine = new Map()
            spine.forEach((id) => rankSpine.set(rank.get(id), id))

            // ---- 3. 认领侧挂件：先认领同层的并行节点，再从主线向外 BFS ----
            const nb = new Map(ids.map((id) => [id, []]))
            own.forEach((e) => {
              nb.get(e.from).push({ id: e.to, e })
              nb.get(e.to).push({ id: e.from, e })
            })
            const sideFromEdge = (anchor, node, e) => {
              const nodePort = node === e.from ? e.fromPort : e.toPort
              const anchorPort = anchor === e.from ? e.fromPort : e.toPort
              if (nodePort === 'left') return 'right'
              if (nodePort === 'right') return 'left'
              if (anchorPort === 'left') return 'left'
              if (anchorPort === 'right') return 'right'
              return null
            }
            const home = new Map()
            const seen = new Set(spine)
            const bfs = spine.slice()
            ids.forEach((id) => {
              if (spineIdx.has(id)) return
              const mate = rankSpine.get(rank.get(id))
              if (!mate) return
              const vTie = nb
                .get(id)
                .some(
                  ({ id: other, e }) =>
                    spineIdx.has(other) && isVertPort(e.fromPort) && isVertPort(e.toPort),
                )
              if (!vTie) return
              home.set(id, { anchor: mate, side: null, parallel: true })
              seen.add(id)
              bfs.push(id)
            })
            while (bfs.length) {
              const cur = bfs.shift()
              nb.get(cur).forEach(({ id, e }) => {
                if (seen.has(id)) return
                seen.add(id)
                home.set(id, { anchor: cur, side: sideFromEdge(cur, id, e), parallel: false })
                bfs.push(id)
              })
            }
            if (home.size + spine.length < ids.length) return null

            // 没有端口信息的并行节点：按原图左右关系决定侧，读不到就左右平衡。
            const sideCount = new Map(spine.map((id) => [id, { left: 0, right: 0 }]))
            home.forEach((h, id) => {
              if (!h.side) return
              const c = sideCount.get(h.anchor)
              if (c) c[h.side]++
            })
            home.forEach((h, id) => {
              if (h.side) return
              const n = nodeOf(id)
              const a = nodeOf(h.anchor)
              let side
              if (n.ox != null && a.ox != null && n.ox !== a.ox) {
                side = n.ox < a.ox ? 'left' : 'right'
              } else {
                const c = sideCount.get(h.anchor) || { left: 0, right: 0 }
                side = c.left <= c.right ? 'left' : 'right'
                c[side]++
              }
              h.side = side
            })

            // ---- 4. 挂件盒：节点 + 左右两侧堆叠的下一层挂件 ----
            const children = new Map(ids.map((id) => [id, []]))
            home.forEach((h, id) => {
              const list = children.get(h.anchor)
              if (list) list.push(id)
            })
            const gapScale = opt.gapScale || 1
            const STACK_GAP = Math.round(56 * gapScale)
            const SIDE_GAP = Math.round(64 * gapScale)
            const V_GAP = Math.round(64 * gapScale)
            const sortShelf = (a, b) => {
              const ra = rank.get(a) || 0
              const rb = rank.get(b) || 0
              if (ra !== rb) return ra - rb
              const na = nodeOf(a)
              const nb2 = nodeOf(b)
              const oa = na.oy != null ? na.oy : na.ord
              const ob = nb2.oy != null ? nb2.oy : nb2.ord
              if (oa !== ob) return oa - ob
              return na.ord - nb2.ord
            }
            const wingBox = (id) => {
              const n = nodeOf(id)
              const kids = (children.get(id) || []).slice().sort(sortShelf)
              const bySide = { left: [], right: [] }
              kids.forEach((k) => {
                const side = (home.get(k) && home.get(k).side) || 'right'
                bySide[side].push(k)
              })
              const pos = new Map([[id, { x: 0, y: 0 }]])
              let top = n.h / 2
              let bottom = n.h / 2
              let left = n.w / 2
              let right = n.w / 2
              ;['left', 'right'].forEach((side) => {
                const boxes = bySide[side].map((k) => wingBox(k))
                if (!boxes.length) return
                const stackH =
                  boxes.reduce((s, b) => s + b.top + b.bottom, 0) + STACK_GAP * (boxes.length - 1)
                const near = n.w / 2 + SIDE_GAP
                let y = -stackH / 2
                boxes.forEach((box) => {
                  const cy = y + box.top
                  const boxW = box.left + box.right
                  const cx = side === 'right' ? near + box.left : -(near + box.right)
                  box.pos.forEach((p, pid) => pos.set(pid, { x: cx + p.x, y: cy + p.y }))
                  const far = near + boxW
                  if (side === 'right') right = Math.max(right, far)
                  else left = Math.max(left, far)
                  y += box.top + box.bottom + STACK_GAP
                })
                top = Math.max(top, stackH / 2)
                bottom = Math.max(bottom, stackH / 2)
              })
              return { id, w: left + right, h: top + bottom, top, bottom, left, right, pos }
            }

            // ---- 5. 每条主线节点的货架：统一一条近边，挂件整齐对齐 ----
            const maxSpineHalf = spine.reduce((m, id) => Math.max(m, nodeOf(id).w / 2), 1)
            const lane = maxSpineHalf + SIDE_GAP
            const perAnchor = new Map(spine.map((id) => [id, { left: [], right: [] }]))
            home.forEach((h, id) => {
              const g = perAnchor.get(h.anchor)
              if (g) g[h.side].push(id)
            })
            const groups = new Map()
            spine.forEach((id) => {
              const n = nodeOf(id)
              const g = perAnchor.get(id)
              const pos = new Map([[id, { x: 0, y: 0 }]])
              let top = n.h / 2
              let bottom = n.h / 2
              let left = n.w / 2
              let right = n.w / 2
              ;['left', 'right'].forEach((side) => {
                const boxes = g[side].slice().sort(sortShelf).map((wid) => wingBox(wid))
                if (!boxes.length) return
                const stackH =
                  boxes.reduce((s, b) => s + b.top + b.bottom, 0) + STACK_GAP * (boxes.length - 1)
                let y = -stackH / 2
                boxes.forEach((box) => {
                  const cy = y + box.top
                  const boxW = box.left + box.right
                  const cx = side === 'right' ? lane + box.left : -(lane + box.right)
                  box.pos.forEach((p, pid) => pos.set(pid, { x: cx + p.x, y: cy + p.y }))
                  y += box.top + box.bottom + STACK_GAP
                  if (side === 'right') right = Math.max(right, lane + boxW)
                  else left = Math.max(left, lane + boxW)
                })
                top = Math.max(top, stackH / 2)
                bottom = Math.max(bottom, stackH / 2)
              })
              groups.set(id, { top, bottom, pos, left, right })
            })

            // 同层的并行节点（如“下载资源 / 创建目录”）围绕主线对称站开：
            // 把锚点 + 这些并行节点整体平移，让它们的中心落在主线上。这样
            // 上方的父节点正好在它们中间，两条斜线等长对称。
            spine.forEach((id) => {
              const g = groups.get(id)
              const paras = ids.filter((pid) => {
                const h = home.get(pid)
                return h && h.parallel && h.anchor === id
              })
              if (!paras.length) return
              let mn = 0
              let mx = 0
              paras.forEach((pid) => {
                const p = g.pos.get(pid)
                if (!p) return
                mn = Math.min(mn, p.x)
                mx = Math.max(mx, p.x)
              })
              const dx = -(mn + mx) / 2
              if (Math.abs(dx) < 0.5) return
              g.pos.forEach((p) => {
                p.x += dx
              })
            })

            // ---- 6. 主线纵向装箱：每组（锚点 + 货架）整体不重叠 ----
            const spineY = new Map()
            let center = 0
            spine.forEach((id, i) => {
              const g = groups.get(id)
              if (i > 0) {
                const pg = groups.get(spine[i - 1])
                center = center + pg.bottom + V_GAP + g.top
              } else {
                center = g.top
              }
              spineY.set(id, center)
            })

            const placed = new Map()
            spine.forEach((id) => {
              const y = spineY.get(id)
              groups.get(id).pos.forEach((p, pid) => {
                const n = nodeOf(pid)
                placed.set(pid, {
                  id: pid,
                  x: p.x - n.w / 2,
                  y: y + p.y - n.h / 2,
                  w: n.w,
                  h: n.h,
                })
              })
            })
            ids.forEach((id) => {
              if (placed.has(id)) return
              const n = nodeOf(id)
              placed.set(id, { id, x: 0, y: 0, w: n.w, h: n.h })
            })

            // ---- 7. 端口：侧挂边一律横着走，主线/并行边按上下 ----
            const isWingOf = (child, parent) => {
              const h = home.get(child)
              return !!(h && h.anchor === parent)
            }
            const ports = {}
            own.forEach((e) => {
              const a = placed.get(e.from)
              const b = placed.get(e.to)
              if (!a || !b) return
              const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 8
              const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 8
              const sideEdge = isWingOf(e.from, e.to) || isWingOf(e.to, e.from)
              let fromPort
              let toPort
              if (sideEdge) {
                const aCenter = a.x + a.w / 2
                const bCenter = b.x + b.w / 2
                fromPort = aCenter <= bCenter ? 'right' : 'left'
                toPort = aCenter <= bCenter ? 'left' : 'right'
              } else if (yOverlap && !xOverlap) {
                fromPort = a.x < b.x ? 'right' : 'left'
                toPort = a.x < b.x ? 'left' : 'right'
              } else {
                fromPort = a.y < b.y ? 'bottom' : 'top'
                toPort = a.y < b.y ? 'top' : 'bottom'
              }
              ports[e.key] = { fromPort, toPort }
            })

            // ---- 8. 输出：平移到 (0,0)，并统计压线/长度供 smart 打分 ----
            let minX = Infinity
            let minY = Infinity
            let maxX = -Infinity
            let maxY = -Infinity
            placed.forEach((it) => {
              minX = Math.min(minX, it.x)
              minY = Math.min(minY, it.y)
              maxX = Math.max(maxX, it.x + it.w)
              maxY = Math.max(maxY, it.y + it.h)
            })
            const sampleEdge = (e) => {
              const a = placed.get(e.from)
              const b = placed.get(e.to)
              const portXY = (it, port) => {
                const cx = it.x + it.w / 2
                const cy = it.y + it.h / 2
                if (port === 'top') return { x: cx, y: it.y }
                if (port === 'bottom') return { x: cx, y: it.y + it.h }
                if (port === 'left') return { x: it.x, y: cy }
                return { x: it.x + it.w, y: cy }
              }
              const fix = ports[e.key]
              const fp = fix ? fix.fromPort : e.fromPort
              const tp = fix ? fix.toPort : e.toPort
              const p1 = portXY(a, fp)
              const p2 = portXY(b, tp)
              const dx = p2.x - p1.x
              const dy = p2.y - p1.y
              const h1 = !isVertPort(fp)
              const h2 = !isVertPort(tp)
              let c1x = p1.x
              let c1y = p1.y
              let c2x = p2.x
              let c2y = p2.y
              if (h1 && h2) {
                const mid = (p1.x + p2.x) / 2
                c1x = mid
                c1y = p1.y
                c2x = mid
                c2y = p2.y
              } else if (!h1 && !h2) {
                const mid = (p1.y + p2.y) / 2
                c1x = p1.x
                c1y = mid
                c2x = p2.x
                c2y = mid
              } else if (h1) {
                c1x = p1.x
                c1y = p1.y + dy * 0.5
                c2x = p1.x + dx * 0.5
                c2y = p2.y
              } else {
                c1x = p1.x + dx * 0.5
                c1y = p1.y
                c2x = p2.x
                c2y = p1.y + dy * 0.5
              }
              const pts = []
              for (let i = 0; i <= 48; i++) {
                const t = i / 48
                const u = 1 - t
                pts.push({
                  x: u * u * u * p1.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p2.x,
                  y: u * u * u * p1.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * p2.y,
                })
              }
              return { pts, a, b }
            }
            let vios = 0
            let len = 0
            own.forEach((e) => {
              const { pts, a, b } = sampleEdge(e)
              for (let i = 1; i < pts.length; i++) {
                len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
              }
              let self = false
              let hit = false
              for (let i = 3; i < pts.length - 3; i++) {
                const p = pts[i]
                placed.forEach((it) => {
                  if (p.x <= it.x + 4 || p.x >= it.x + it.w - 4) return
                  if (p.y <= it.y + 4 || p.y >= it.y + it.h - 4) return
                  if (it === a || it === b) self = true
                  else hit = true
                })
              }
              if (self) vios += 2
              if (hit) vios += 1
            })

            const items = ids.map((id) => {
              const it = placed.get(id)
              return { id, x: it.x - minX, y: it.y - minY }
            })
            return {
              items,
              w: maxX - minX,
              h: maxY - minY,
              ports,
              vios,
              len,
              cross: crossingCount(items, own, ports),
            }
          }

          // ================================================================
          // 收尾引擎（分层 / 力导向两种策略共用）：
          // 行高行距 → 坐标求解 → 重心精修 → 复核修复 → 镜像 → 端口优化 → 输出
          // ================================================================
          function finishBlock(ctx) {
            const rows = ctx.rows
            const own = ctx.own
            const itemOf = ctx.itemOf
            const deg = ctx.deg
            const adjReal = ctx.adjReal
            const hPair = ctx.hPair
            const cut = ctx.cut
            const canPin = !!ctx.canPin
            const useMirror = !!ctx.useMirror
            const forceDesire = ctx.forceDesire || null
            const naturalAll = !!ctx.naturalAll

            // 2.7 行高与行距：层内统一居中（同一层的端口中心自然对齐），
            //     行与行之间留出整条水平空隙给连线走。
            const rowH = rows.map((row) => row.reduce((m, it) => Math.max(m, it.h), 1))
            const rowTop = []
            let stackY = 0
            const rowGapEff = ctx.rowGap != null ? ctx.rowGap : ROW_GAP
            rows.forEach((row, r) => {
              rowTop[r] = stackY
              stackY += rowH[r] + rowGapEff
            })
            rows.forEach((row, r) => {
              row.forEach((it) => {
                it.y = rowTop[r] + (rowH[r] - it.h) / 2
              })
            })

            // 2.8 逐层定位：硬对齐（长连线的通道、只连一条线的叶子）一定落在
            //     目标中心上，绝不因为左边的邻居被推歪；普通节点在两段硬对齐
            //     之间尽量向父节点中心靠。行内只准让位，不准交叉重叠。
            const gapTo = (a, b) => COL_GAP + (a.halo || 0) + (b.halo || 0)
            // 硬对齐的项可以把它和左边邻居的净距压到 MIN_GAP（仍然不会重叠），
            // 这样“两边都要精确对齐、目标只差一点点”时不用牺牲其中一条线。
            const gapHard = (a, b) => MIN_GAP + (a.halo || 0) + (b.halo || 0)
            const solveRow = (row) => {
              if (!row.length) return
              const wantLeft = (it) =>
                it.pin != null ? it.pin - it.w / 2 : it.desire != null ? it.desire - it.w / 2 : null
              const leftLimit = (i) => {
                if (i <= 0) return -Infinity
                const prev = row[i - 1]
                return (
                  prev.x +
                  prev.w +
                  (row[i].pin != null ? gapHard(prev, row[i]) : gapTo(prev, row[i]))
                )
              }
              // 左→右：硬对齐（一对一的叶子、长连线的通道）要精确落在目标上。
              // 左边顶住了，先把“上一个硬对齐之后的那一段”整体往左挪（整行
              // 可以向左延伸，不遮挡就行）；硬对齐还可以和左邻居压到 MIN_GAP；
              // 实在放不下才降级成普通期望 —— 比如一个父节点下挂好几个孩子，
              // 都想对齐到同一个中心，那就只有第一个对得上，其余自然排开。
              let lastPin = -1
              row.forEach((it, i) => {
                let want = wantLeft(it)
                if (i > 0) {
                  let limit = leftLimit(i)
                  if (it.pin != null && want != null && want < limit - 0.5) {
                    const prevPin = lastPin >= 0 ? row[lastPin] : null
                    const first = prevPin ? row[lastPin + 1] : null
                    const room =
                      prevPin && first
                        ? first.x -
                          (prevPin.x +
                            prevPin.w +
                            (first.pin != null ? gapHard(prevPin, first) : gapTo(prevPin, first)))
                        : Infinity
                    const shift = Math.min(limit - want, Math.max(0, room))
                    if (shift > 0.5) {
                      for (let k = lastPin + 1; k < i; k++) row[k].x -= shift
                      limit = leftLimit(i)
                    }
                    if (want < limit - 0.5) {
                      it.pin = null
                      if (it.desire == null) it.desire = want + it.w / 2
                      want = wantLeft(it)
                      limit = leftLimit(i)
                    }
                  }
                  it.x = want == null ? limit : Math.max(limit, want)
                } else {
                  it.x = want == null ? 0 : want
                }
                if (it.pin != null) lastPin = i
              })
              // 右→左：没有硬对齐的往期望位置收，但不能挤到两边邻居
              for (let i = row.length - 2; i >= 0; i--) {
                const it = row[i]
                if (it.pin != null) continue
                const right = row[i + 1]
                const lb = leftLimit(i)
                const rb =
                  right.x - it.w - (right.pin != null ? gapHard(it, right) : gapTo(it, right))
                const want = it.desire != null ? it.desire - it.w / 2 : it.x
                it.x = Math.max(lb, Math.min(Math.max(want, lb), rb))
              }
            }

            // mode：'preds' 只按父节点中心（首次铺排，自上而下）；
            //       'down' / 'up' 重心精修——期望位置 = 父节点中心 + 真实
            //       邻居（含子节点）中心的重心，上下交替扫把相连的点拉近、
            //       消掉逐层向右下的对角漂移。pin 的硬对齐和通道链在每次
            //       placeAll 都按最新几何重新推导，竖直直线不会被掰弯。
            const placeAll = (mode) => {
              const m = mode || 'preds'
              const order = []
              for (let r = 0; r < rows.length; r++) order.push(r)
              if (m === 'up') order.reverse()
              order.forEach((r) => {
                const row = rows[r]
                row.forEach((it) => {
                  it.pin = null
                  it.desire = null
                  it.anchor = null
                  if (!it.preds.length) {
                    if (m === 'preds') {
                      // 首次铺排：力导向块用力模拟收敛出的 x 作期望；
                      // 分层块顶层没有父节点，保持原样（从左侧依次排开）
                      if (forceDesire) it.desire = forceDesire.get(it.id)
                    } else {
                      // 重心精修：顶层节点向它的真实邻居重心靠拢
                      let s2 = 0
                      let c2 = 0
                      ;(adjReal.get(it.id) || []).forEach((nid) => {
                        const nb = itemOf.get(nid)
                        if (nb && nb.real) {
                          s2 += nb.x + nb.w / 2
                          c2++
                        }
                      })
                      if (c2) it.desire = s2 / c2
                    }
                    return
                  }
                  const chained = it.preds.filter((p) => !p.real)
                  if (!it.real) {
                    // 虚拟通道：永远对齐到链首（源头节点中心，逐段传下来）
                    const src = it.preds.find((p) => p.anchor != null)
                    it.anchor = src ? src.anchor : it.preds[0].x + it.preds[0].w / 2
                    it.pin = it.anchor
                  } else if (chained.length) {
                    // 长连线的末端：同样对齐链首，整条线才是一条直线
                    const src = chained.find((p) => p.anchor != null)
                    it.anchor = src ? src.anchor : chained[0].x + chained[0].w / 2
                    it.pin = it.anchor
                  } else if (
                    canPin &&
                    it.preds.length === 1 &&
                    (deg.get(it.id) === 1 || deg.get(it.preds[0].id) === 1)
                  ) {
                    // 一对一的连线（这一端或者那一端只连了这一条线）：硬对齐到
                    // 父节点中心，连线就是一条竖直直线（摆不下时会自动降级）
                    it.pin = it.preds[0].x + it.preds[0].w / 2
                  } else {
                    let s2 = 0
                    let c2 = 0
                    it.preds.forEach((p) => {
                      s2 += p.x + p.w / 2
                      c2++
                    })
                    if (m !== 'preds') {
                      ;(adjReal.get(it.id) || []).forEach((nid) => {
                        const nb = itemOf.get(nid)
                        if (nb && nb.real) {
                          s2 += nb.x + nb.w / 2
                          c2++
                        }
                      })
                    }
                    if (c2) it.desire = s2 / c2
                  }
                })
                solveRow(row)
              })
            }
            const portXY = (it, port) => {
              const cx = it.x + it.w / 2
              const cy = it.y + it.h / 2
              if (port === 'top') return { x: cx, y: it.y }
              if (port === 'bottom') return { x: cx, y: it.y + it.h }
              if (port === 'left') return { x: it.x, y: cy }
              if (port === 'right') return { x: it.x + it.w, y: cy }
              return { x: cx, y: cy }
            }
            // 与 ConnectionManager._getCurvePath 完全一致的控制点，采样成折线
            const edgeSamples = (e, sampleCount) => {
              const S2 = sampleCount || SAMPLES
              const aIt = itemOf.get(e.from)
              const bIt = itemOf.get(e.to)
              const p1 = portXY(aIt, e.fromPort)
              const p2 = portXY(bIt, e.toPort)
              const dx = p2.x - p1.x
              const dy = p2.y - p1.y
              const h1 = isHorzPort(e.fromPort)
              const h2 = isHorzPort(e.toPort)
              const v1 = isVertPort(e.fromPort)
              const v2 = isVertPort(e.toPort)
              let c1x = p1.x
              let c1y = p1.y
              let c2x = p2.x
              let c2y = p2.y
              if (h1 && h2) {
                const mid = (p1.x + p2.x) / 2
                c1x = mid
                c1y = p1.y
                c2x = mid
                c2y = p2.y
              } else if (v1 && v2) {
                const mid = (p1.y + p2.y) / 2
                c1x = p1.x
                c1y = mid
                c2x = p2.x
                c2y = mid
              } else if (h1 && v2) {
                c1x = p1.x
                c1y = p1.y + dy * 0.5
                c2x = p1.x + dx * 0.5
                c2y = p2.y
              } else {
                c1x = p1.x + dx * 0.5
                c1y = p1.y
                c2x = p2.x
                c2y = p1.y + dy * 0.5
              }
              const pts = []
              for (let i = 0; i <= SAMPLES; i++) {
                const t = i / SAMPLES
                const u = 1 - t
                pts.push({
                  x:
                    u * u * u * p1.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p2.x,
                  y:
                    u * u * u * p1.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * p2.y,
                })
              }
              return pts
            }
            const hitsNode = (pts, it) => {
              for (let i = 0; i < pts.length; i++) {
                const p = pts[i]
                if (
                  p.x > it.x - SAFE &&
                  p.x < it.x + it.w + SAFE &&
                  p.y > it.y - SAFE &&
                  p.y < it.y + it.h + SAFE
                ) {
                  return true
                }
              }
              return false
            }
            // 连线自己也不能从端点的身子里穿过去（bottom→bottom 这类拧着
            // 画的端口会出现这种情况），端口部位附近不算。
            const selfClip = (e, pts) => {
              for (let i = 3; i < pts.length - 3; i++) {
                const p = pts[i]
                const ok = [e.from, e.to].some((id) => {
                  const it = itemOf.get(id)
                  if (!it) return false
                  return (
                    p.x > it.x + SAFE &&
                    p.x < it.x + it.w - SAFE &&
                    p.y > it.y + SAFE &&
                    p.y < it.y + it.h - SAFE
                  )
                })
                if (ok) return true
              }
              return false
            }
            // 复核：每条连线（按真实端口画出的曲线采样）都不能压到别的节点
            const verifyBlock = (sampleCount) => {
              const found = []
              const realRows = rows.map((row) => row.filter((it) => it.real))
              own.forEach((e) => {
                const a = itemOf.get(e.from)
                const b = itemOf.get(e.to)
                if (!a || !b) return
                const pts = edgeSamples(e, sampleCount)
                let x0 = Infinity
                let x1 = -Infinity
                let y0 = Infinity
                let y1 = -Infinity
                pts.forEach((p) => {
                  if (p.x < x0) x0 = p.x
                  if (p.x > x1) x1 = p.x
                  if (p.y < y0) y0 = p.y
                  if (p.y > y1) y1 = p.y
                })
                rows.forEach((row, r) => {
                  if (rowTop[r] > y1 + SAFE || rowTop[r] + rowH[r] < y0 - SAFE) return
                  realRows[r].forEach((it) => {
                    if (it === a || it === b) return
                    if (it.x > x1 + SAFE || it.x + it.w < x0 - SAFE) return
                    if (hitsNode(pts, it)) found.push({ e: e, it: it, pts: pts })
                  })
                })
                if (selfClip(e, pts)) {
                  const mid = itemOf.get(e.from)
                  if (mid) found.push({ e: e, it: mid, pts: pts, self: true })
                }
              })
              return found
            }
            // 修复：谁挡了路就把谁挪开 ——
            //  1) 被扫到的节点如果紧挨着连线的落脚点、自己又没有任何父节点要照顾，
            //     直接和它换个位置：连线不用拐弯，整行也不会被撑大；
            //  2) 换不了位的，就加大这一段间距，把节点从连线的横向范围里让出去。
            const applyFixes = (vios) => {
              vios.forEach((v) => {
                if (v.self) return // 自己穿自己的端点：只能换端口，挪不动
                const e = v.e
                const it = v.it
                const row = rows[it.row]
                const eItem =
                  row &&
                  row.find((x) => (x.real && (x.id === e.from || x.id === e.to)) || x.chain === e)
                if (!eItem) return
                const top = rowTop[it.row]
                const bottom = top + rowH[it.row]
                let dev = 0
                v.pts.forEach((p) => {
                  if (p.y < top - SAFE || p.y > bottom + SAFE) return
                  const c = eItem.x + eItem.w / 2
                  const d = Math.abs(p.x - c)
                  if (d > dev) dev = d
                })
                if (dev <= 0) return
                // 1) 换位：只动一个自由节点，最省事也最不容易连锁
                if (it.preds.length === 0 && !hPair.has(it.key)) {
                  const idx = row.indexOf(it)
                  const jdx = row.indexOf(eItem)
                  if (idx >= 0 && jdx >= 0 && Math.abs(idx - jdx) === 1) {
                    row[idx] = eItem
                    row[jdx] = it
                    return
                  }
                }
                // 2) 兜底：加大间距，把节点从连线的横向范围里让出去
                const gapNow = COL_GAP + (eItem.halo || 0) + (it.halo || 0)
                const extra = dev + SAFE - eItem.w / 2 - gapNow
                if (extra > 0.5) it.halo = Math.min(MAX_HALO, (it.halo || 0) + extra + 2)
              })
            }

            // —— 力导向块：相邻行中位数扫描降交叉（守卫用真实穿线数）——
            const fPred = ctx.forcePred
            const fSucc = ctx.forceSucc
            if (fPred) {
              const medianF2 = (arr) => {
                if (!arr.length) return null
                const s3 = arr.slice().sort((a, b) => a - b)
                const m3 = s3.length >> 1
                return s3.length % 2 ? s3[m3] : (s3[m3 - 1] + s3[m3]) / 2
              }
              const resortF2 = (r, usePred) => {
                const row = rows[r]
                row.forEach((it) => {
                  const nb = usePred ? fPred.get(it.id) : fSucc.get(it.id)
                  it._m = nb && nb.length ? medianF2(nb.map((p) => p.pos)) : null
                })
                row.sort(
                  (a, b) => (a._m === null ? a.pos : a._m) - (b._m === null ? b.pos : b._m),
                )
                row.forEach((it, i) => (it.pos = i))
              }
              const orderSnapF = () => rows.map((row) => row.map((it) => it.key))
              const orderRestoreF = (snap) => {
                rows.forEach((row, r) => {
                  const order = snap[r]
                  row.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
                  row.forEach((it, i) => (it.pos = i))
                })
              }
              placeAll('preds')
              const clip0 = verifyBlock().length
              const ord0 = orderSnapF()
              for (let it2 = 0; it2 < 8; it2++) {
                if (it2 % 2 === 0) for (let r = 1; r < rows.length; r++) resortF2(r, true)
                else for (let r = rows.length - 2; r >= 0; r--) resortF2(r, false)
              }
              placeAll('preds')
              if (verifyBlock().length > clip0) {
                orderRestoreF(ord0)
                placeAll('preds')
              }
            }


            // 2.8.1 定序与坐标互相校正：先按父节点中心摆一遍位置，再按摆出来
            //       的位置把层内顺序理顺（水平连线的连续块当作整体），再摆一遍。
            //       顺序和期望位置一致之后，谁都不会被硬生生挤到很远的地方，
            //       长连线也不会横着扫过好几层。
            const rowBlockKeys = (row) => {
              const ids = new Map()
              let seq = 0
              row.forEach((it) => {
                if (ids.has(it.key)) return
                const stack = [it.key]
                ids.set(it.key, seq)
                while (stack.length) {
                  const k = stack.pop()
                  ;(hPair.get(k) || []).forEach((nk) => {
                    if (ids.has(nk)) return
                    ids.set(nk, seq)
                    stack.push(nk)
                  })
                }
                seq++
              })
              return ids
            }
            for (let round = 0; round < 2; round++) {
              placeAll('preds')
              rows.forEach((row, r) => {
                if (r === 0 || row.length < 2) return
                const meta = rowBlockKeys(row)
                const sum = new Map()
                const cnt = new Map()
                let any = false
                row.forEach((it) => {
                  const w = it.pin != null ? it.pin : it.desire
                  if (w == null) return
                  any = true
                  const b = meta.get(it.key)
                  sum.set(b, (sum.get(b) || 0) + w)
                  cnt.set(b, (cnt.get(b) || 0) + 1)
                })
                if (!any) return
                const key = (it) => {
                  const b = meta.get(it.key)
                  return sum.has(b) ? sum.get(b) / cnt.get(b) : it.x + it.w / 2
                }
                rows[r] = row.slice().sort((a, b) => key(a) - key(b))
              })
            }
            placeAll('preds')

            // —— 重心精修：上下交替扫几轮，只保留“总连线长度更短”的结果。
            // 这是把相连的节点拉近（用户核心诉求）、消掉对角漂移的主力。
            const totalEdgeLen = () => {
              let L = 0
              own.forEach((e) => {
                const pts = edgeSamples(e)
                for (let i = 1; i < pts.length; i++) {
                  L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
                }
              })
              return L
            }
            const snapX = () => {
              const out = new Map()
              rows.forEach((row) => row.forEach((it) => out.set(it.key, it.x)))
              return out
            }
            const restoreX = (snap) => {
              rows.forEach((row) =>
                row.forEach((it) => {
                  const v = snap.get(it.key)
                  if (v != null) it.x = v
                }),
              )
            }
            const initSnap = snapX()
            const initVios = verifyBlock().length
            let bestLen = totalEdgeLen()
            let bestSnap = initSnap
            for (let s = 0; s < 8; s++) {
              placeAll(s % 2 === 0 ? 'down' : 'up')
              const L = totalEdgeLen()
              if (L < bestLen - 1) {
                bestLen = L
                bestSnap = snapX()
              }
            }
            restoreX(bestSnap)

            const runRepairs = () => {
              const R = ctx.repairs || REPAIRS
              for (let round = 0; round < R; round++) {
                const vios = verifyBlock()
                if (!vios.length) break
                applyFixes(vios)
                placeAll('preds')
              }
            }
            // 安全阀：精修可能把节点挪进连线的路径里。修复后若穿线反而
            // 比精修前多，说明这个块不适合精修（比如连线通道恰好被占），
            // 整块回滚到精修前的坐标再修复一次——宁要整齐，不要紧凑的事故。
            const initLen = totalEdgeLen()
            runRepairs()
            if (verifyBlock().length > initVios || totalEdgeLen() > initLen + 1) {
              restoreX(initSnap)
              runRepairs()
            }

            // 2.8.2 整块朝向：right→left 这类水平连线本身就写着“谁在左边”，
            //       如果整块排出来正好反了，把这一块左右镜像一下 —— 镜像不改变
            //       任何相对关系（不遮挡的依旧不遮挡），却能把方向掰正。
            const hStraight = own.filter((e) => e.kind === 'H' && !e.loose)
            const countFlipped = () => {
              let bad = 0
              hStraight.forEach((e) => {
                const l = itemOf.get(e.left)
                const r = itemOf.get(e.right)
                if (!l || !r || l === r) return
                if (l.x + l.w / 2 > r.x + r.w / 2) bad++
              })
              return bad
            }
            if (useMirror && hStraight.length && countFlipped() * 2 > hStraight.length) {
              let mirrorMin = Infinity
              let mirrorMax = -Infinity
              rows.forEach((row) => {
                row.forEach((it) => {
                  if (!it.real) return
                  if (it.x < mirrorMin) mirrorMin = it.x
                  if (it.x + it.w > mirrorMax) mirrorMax = it.x + it.w
                })
              })
              if (isFinite(mirrorMin)) {
                rows.forEach((row) => {
                  row.forEach((it) => {
                    it.x = mirrorMin + mirrorMax - it.x - it.w
                  })
                })
              }
            }

            // 2.9 端口：松散/破环的连线本来就不按原端口朝向排（比如同一对
            //     节点既连了上下又连了左右），照原端口画会绕一大圈，这里按
            //     实际几何给它换一个顺手的朝向；复核后仍压着节点的连线也
            //     在这里兜底换端口 —— 两条曲线的取舍以“压到几个节点、曲线
            //     多长”为准，宁可不换。
            const portFix = {}
            // 曲线打分：自穿（线穿过端点自己的身子）最恶劣，压到别的节点
            // 次之，最后才看长短。分开计罚才能在“自穿但短”和“绕一点但
            // 干净”之间做出正确取舍——原来的合并计数会让这类互换永远平局。
            const curveScore = (e) => {
              const pts = edgeSamples(e)
              const a = itemOf.get(e.from)
              const b = itemOf.get(e.to)
              let penalty = selfClip(e, pts) ? 100000 : 0
              rows.forEach((row) => {
                row.forEach((it) => {
                  if (!it.real || it === a || it === b) return
                  if (hitsNode(pts, it)) penalty += 50000
                })
              })
              let len = 0
              for (let i = 1; i < pts.length; i++) {
                len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
              }
              return penalty + len
            }
            const naturalPorts = (e) => {
              const a = itemOf.get(e.from)
              const b = itemOf.get(e.to)
              if (!a || !b) return null
              if (a.row !== b.row) {
                const upper = a.row < b.row ? a : b
                return {
                  fromPort: upper === a ? 'bottom' : 'top',
                  toPort: upper === a ? 'top' : 'bottom',
                }
              }
              const left = a.x <= b.x ? a : b
              return {
                fromPort: left === a ? 'right' : 'left',
                toPort: left === a ? 'left' : 'right',
              }
            }
            own.forEach((e) => {
              if (!naturalAll && !e.loose && !cut.has(e)) return
              const nat = naturalPorts(e)
              if (!nat) return
              if (nat.fromPort === e.fromPort && nat.toPort === e.toPort) return
              const fp0 = e.fromPort
              const tp0 = e.toPort
              const before = curveScore(e)
              e.fromPort = nat.fromPort
              e.toPort = nat.toPort
              if (curveScore(e) < before) {
                portFix[e.key] = nat
              } else {
                e.fromPort = fp0
                e.toPort = tp0
              }
            })
            const residual = verifyBlock()
            if (residual.length) {
              const bad = []
              const badSeen = new Set()
              residual.forEach((v) => {
                if (badSeen.has(v.e.key)) return
                badSeen.add(v.e.key)
                bad.push(v.e)
              })
              const ALL_PORTS = ['top', 'bottom', 'left', 'right']
              bad.forEach((e) => {
                const fp0 = e.fromPort
                const tp0 = e.toPort
                let best = curveScore(e)
                let bestPair = null
                ALL_PORTS.forEach((fp) => {
                  ALL_PORTS.forEach((tp) => {
                    if (fp === fp0 && tp === tp0) return
                    e.fromPort = fp
                    e.toPort = tp
                    const s = curveScore(e)
                    if (s < best) {
                      best = s
                      bestPair = { fromPort: fp, toPort: tp }
                    }
                  })
                })
                if (bestPair) {
                  e.fromPort = bestPair.fromPort
                  e.toPort = bestPair.toPort
                  portFix[e.key] = bestPair
                } else {
                  e.fromPort = fp0
                  e.toPort = tp0
                }
              })
            }

            // 2.9.5 折线兜底：16 组端口组合都救不回来的连线（画出来要么
            // 自穿要么压节点），改画横平竖直的折线——出端口走一小段，
            // 沿“通道”绕行、圆角拐弯。候选路线按节点几何打分，只接受
            // 完全干净的折线；hint 记住选型，渲染端用同一算法 + 当前几何
            // 重建路径（节点挪动后路线跟随移动）。
            const ELBOW_STUB = 26
            const PORT_DIR = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }
            const elbowWaypoints = (p1, d1, p2, d2, v, k, box) => {
              const stub = ELBOW_STUB * (1 + k * 0.6)
              const s1 = { x: p1.x + d1[0] * stub, y: p1.y + d1[1] * stub }
              const s2 = { x: p2.x + d2[0] * stub, y: p2.y + d2[1] * stub }
              const v1 = d1[1] !== 0
              const v2 = d2[1] !== 0
              const laneT = k === 1 ? 0.25 : k === 2 ? 0.75 : k === 3 ? 1.3 : k === 4 ? -0.3 : k === 5 ? 1.6 : k === 6 ? -0.6 : 0.5
              if (v === 'lane' && v1 && v2) {
                const lane = s1.y + (s2.y - s1.y) * laneT
                return [p1, s1, { x: s1.x, y: lane }, { x: s2.x, y: lane }, s2, p2]
              }
              if (v === 'lane' && !v1 && !v2) {
                const lane = s1.x + (s2.x - s1.x) * laneT
                return [p1, s1, { x: lane, y: s1.y }, { x: lane, y: s2.y }, s2, p2]
              }
              if (v === 'aroundL' || v === 'aroundR') {
                const m = stub + 30 + k * 70
                if (v1 && v2) {
                  const laneX = v === 'aroundL' ? box.x0 - m : box.x1 + m
                  return [p1, s1, { x: laneX, y: s1.y }, { x: laneX, y: s2.y }, s2, p2]
                }
                if (!v1 && !v2) {
                  const laneY = v === 'aroundL' ? box.y0 - m : box.y1 + m
                  return [p1, s1, { x: s1.x, y: laneY }, { x: s2.x, y: laneY }, s2, p2]
                }
                const cx = v === 'aroundL' ? box.x0 - m : box.x1 + m
                const cy = v === 'aroundL' ? box.y0 - m : box.y1 + m
                return v1
                  ? [p1, s1, { x: s1.x, y: cy }, { x: cx, y: cy }, { x: cx, y: s2.y }, s2, p2]
                  : [p1, s1, { x: cx, y: s1.y }, { x: cx, y: cy }, { x: s2.x, y: cy }, s2, p2]
              }
              if (v === 'L') {
                if (v1 && !v2) return [p1, s1, { x: s2.x, y: s1.y }, s2, p2]
                if (!v1 && v2) return [p1, s1, { x: s1.x, y: s2.y }, s2, p2]
                if (v1 && v2) {
                  const lane = (s1.y + s2.y) / 2
                  return [p1, s1, { x: s1.x, y: lane }, { x: s2.x, y: lane }, s2, p2]
                }
                const lane = (s1.x + s2.x) / 2
                return [p1, s1, { x: lane, y: s1.y }, { x: lane, y: s2.y }, s2, p2]
              }
              return [p1, p2]
            }
            const elbowSample = (e, hint) => {
              const a = itemOf.get(e.from)
              const b = itemOf.get(e.to)
              const p1 = portXY(a, e.fromPort)
              const p2 = portXY(b, e.toPort)
              const box = {
                x0: Math.min(a.x, b.x),
                y0: Math.min(a.y, b.y),
                x1: Math.max(a.x + a.w, b.x + b.w),
                y1: Math.max(a.y + a.h, b.y + b.h),
              }
              const wps = elbowWaypoints(
                p1,
                PORT_DIR[e.fromPort],
                p2,
                PORT_DIR[e.toPort],
                hint.v,
                hint.k,
                box,
              )
              const pts = []
              for (let i = 0; i + 1 < wps.length; i++) {
                const A = wps[i]
                const B = wps[i + 1]
                const d = Math.hypot(B.x - A.x, B.y - A.y)
                const n = Math.max(1, Math.round(d / 8))
                for (let j = 0; j < n; j++) {
                  pts.push({ x: A.x + ((B.x - A.x) * j) / n, y: A.y + ((B.y - A.y) * j) / n })
                }
              }
              pts.push(wps[wps.length - 1])
              return pts
            }
            const routePenalty = (pts, e) => {
              const a = itemOf.get(e.from)
              const b = itemOf.get(e.to)
              let pen = 0
              rows.forEach((row) => {
                row.forEach((it) => {
                  if (!it.real || it === a || it === b) return
                  if (hitsNode(pts, it)) pen++
                })
              })
              const selfHit = pts.some((p) =>
                [a, b].some(
                  (it) =>
                    p.x > it.x + SAFE &&
                    p.x < it.x + it.w - SAFE &&
                    p.y > it.y + SAFE &&
                    p.y < it.y + it.h - SAFE,
                ),
              )
              if (selfHit) pen += 2
              return pen
            }
            const curvePenalty = (e) => routePenalty(edgeSamples(e), e)
            const elbowFixed = new Set()
            own.forEach((e) => {
              const pen0 = curvePenalty(e)
              if (pen0 === 0) return
              const a = itemOf.get(e.from)
              const b = itemOf.get(e.to)
              const v1 = isVertPort(e.fromPort)
              const v2 = isVertPort(e.toPort)
              const combos =
                v1 === v2
                  ? [
                      ['lane', 0],
                      ['lane', 1],
                      ['lane', 2],
                      ['lane', 3],
                      ['lane', 4],
                      ['lane', 5],
                      ['lane', 6],
                      ['aroundL', 0],
                      ['aroundR', 0],
                      ['aroundL', 1],
                      ['aroundL', 2],
                      ['aroundR', 1],
                      ['aroundR', 2],
                      ['aroundL', 3],
                      ['aroundR', 3],
                      ['aroundL', 4],
                      ['aroundR', 4],
                    ]
                  : [
                      ['L', 0],
                      ['L', 1],
                      ['L', 2],
                      ['aroundL', 0],
                      ['aroundR', 0],
                      ['aroundL', 1],
                      ['aroundL', 2],
                      ['aroundR', 1],
                      ['aroundR', 2],
                      ['aroundL', 3],
                      ['aroundR', 3],
                      ['aroundL', 4],
                      ['aroundR', 4],
                    ]
              let best = null
              let bestPen = pen0
              combos.forEach(([v, k]) => {
                const pen = routePenalty(elbowSample(e, { v: v, k: k }), e)
                if (pen < bestPen) {
                  bestPen = pen
                  best = { v: v, k: k }
                }
              })
              // 严格改进（折线比曲线少压节点/少自穿）就改画折线；
              // 完全干净的折线（bestPen===0）才从 vios 里减除
              if (best && bestPen < pen0) {
                portFix[e.key] = {
                  fromPort: e.fromPort,
                  toPort: e.toPort,
                  route: 'elbow',
                  hint: best,
                }
                if (bestPen === 0) elbowFixed.add(e.key)
              }
            })

            // 端口决策权威化：每条边都给出最终端口决策，应用端据此
            // 清掉过期状态（比如上一轮排布留下的折线标记）。
            own.forEach((e) => {
              if (!portFix[e.key]) portFix[e.key] = { fromPort: e.fromPort, toPort: e.toPort }
            })

            // 2.10 输出：把这一块平移到 (0,0) 起点
            let minX = Infinity
            let minY = Infinity
            let maxX = -Infinity
            let maxY = -Infinity
            rows.forEach((row) => {
              row.forEach((it) => {
                if (!it.real) return
                if (it.x < minX) minX = it.x
                if (it.y < minY) minY = it.y
                if (it.x + it.w > maxX) maxX = it.x + it.w
                if (it.y + it.h > maxY) maxY = it.y + it.h
              })
            })
            if (!isFinite(minX)) {
              minX = 0
              minY = 0
              maxX = 0
              maxY = 0
            }
            const items = []
            rows.forEach((row) => {
              row.forEach((it) => {
                if (it.real) items.push({ id: it.id, x: it.x - minX, y: it.y - minY })
              })
            })
            return {
              items: items,
              w: maxX - minX,
              h: maxY - minY,
              ports: portFix,
              cross: crossingCount(items, own, portFix),
              // 加权违规数（加密采样，自穿权重 2，与视觉感受一致，供 smart 择优）；
              // 折线兜底已干净的边不再计入
              vios: (() => {
                const w = new Map()
                verifyBlock(128).forEach((v) => {
                  if (elbowFixed.has(v.e.key)) return
                  w.set(v.e.key, Math.max(w.get(v.e.key) || 0, v.self ? 2 : 1))
                })
                let total = 0
                w.forEach((x) => (total += x))
                return total
              })(),
              len: totalEdgeLen(),
            }
          }

          // ================================================================
          // 单块排布·力导向：稠密 / 多环图的专用通道。
          // FR 式力模拟把有连线的节点拉到一起（连线当弹簧、无关节点互斥），
          // 然后按 y 聚类成行、行内按 x 排序，交给与分层策略同一套
          // finishBlock 收尾（求解—精修—复核—端口优化），输出一样整齐。
          // 分层策略处理稠密图会“加 halo 让路 → 行距爆炸 → 连线更长”
          // 正反馈，画布被撑到上万像素；力导向从根上没有这个问题。
          // ================================================================
          function layoutBlockForce(ids) {
            const inBlock = new Set(ids)
            const own = edges.filter((e) => inBlock.has(e.from) && inBlock.has(e.to))
            const itemOf = new Map()
            ids.forEach((id) => {
              const n = nodeById.get(id)
              itemOf.set(id, {
                key: id,
                id: id,
                real: true,
                w: n.w,
                h: n.h,
                row: 0,
                halo: 0,
                preds: [],
                succs: [],
              })
            })
            const deg = new Map()
            ids.forEach((id) => deg.set(id, 0))
            own.forEach((e) => {
              deg.set(e.from, deg.get(e.from) + 1)
              deg.set(e.to, deg.get(e.to) + 1)
            })
            const adjReal = new Map()
            ids.forEach((id) => adjReal.set(id, []))
            own.forEach((e) => {
              if (e.from === e.to) return
              adjReal.get(e.from).push(e.to)
              adjReal.get(e.to).push(e.from)
            })

            // —— 确定性伪随机：同一块每次排布结果一致（可重复、可撤销）
            let fseed = 0x9e3779b9
            ids.forEach((id) => {
              for (let i = 0; i < id.length; i++) fseed = (fseed * 31 + id.charCodeAt(i)) | 0
            })
            const rndF = () => {
              fseed |= 0
              fseed = (fseed + 0x6d2b79f5) | 0
              let t = Math.imul(fseed ^ (fseed >>> 15), 1 | fseed)
              t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
              return ((t ^ (t >>> 14)) >>> 0) / 4294967296
            }

            const n = ids.length
            let sumW = 0
            let sumH = 0
            ids.forEach((id) => {
              sumW += itemOf.get(id).w
              sumH += itemOf.get(id).h
            })
            const avgW = sumW / n
            const avgH = sumH / n
            // 初始位置：圆环撒点
            const R = Math.max(200, Math.sqrt(n) * (avgW + COL_GAP) * 0.8)
            ids.forEach((id, i) => {
              const it = itemOf.get(id)
              const ang = (i / n) * Math.PI * 2 + rndF() * 0.5
              it.fx = Math.cos(ang) * R * (0.7 + rndF() * 0.6)
              it.fy = Math.sin(ang) * R * (0.7 + rndF() * 0.6)
            })

            if (n > 3 && own.length) {
              // 平衡距离取小一些：排布收尾还有重心精修补刀，力模拟只管把
              // 邻接关系聚成团，太大会把画布撑得很空。
              const K = Math.max(240, Math.min(360, avgW * 0.95 + COL_GAP * 2))
              const MINSEP = Math.min(avgW, avgH) * 0.55 + COL_GAP
              let temp = K * 0.45
              let cx0 = 0
              let cy0 = 0
              ids.forEach((id) => {
                cx0 += itemOf.get(id).fx
                cy0 += itemOf.get(id).fy
              })
              cx0 /= n
              cy0 /= n
              for (let iter = 0; iter < 240; iter++) {
                // 斥力（所有节点两两互斥，靠太近时额外加压）
                for (let i = 0; i < ids.length; i++) {
                  const a = itemOf.get(ids[i])
                  for (let j = i + 1; j < ids.length; j++) {
                    const b = itemOf.get(ids[j])
                    let dx = a.fx - b.fx
                    let dy = a.fy - b.fy
                    let d2 = dx * dx + dy * dy
                    if (d2 < 1) {
                      dx = rndF() - 0.5
                      dy = rndF() - 0.5
                      d2 = 1
                    }
                    const d = Math.sqrt(d2)
                    // 标准 FR 斥力：K²/d（平衡距离 = K）
                    let f = (K * K) / d
                    if (d < MINSEP) f += (MINSEP - d) * 8
                    const fx = (dx / d) * f
                    const fy = (dy / d) * f
                    a._dx = (a._dx || 0) + fx
                    a._dy = (a._dy || 0) + fy
                    b._dx = (b._dx || 0) - fx
                    b._dy = (b._dy || 0) - fy
                  }
                }
                // 引力（连线当弹簧，把相连的点拉到一起）
                own.forEach((e) => {
                  const a = itemOf.get(e.from)
                  const b = itemOf.get(e.to)
                  const dx = b.fx - a.fx
                  const dy = b.fy - a.fy
                  const d = Math.max(1, Math.hypot(dx, dy))
                  const f = (d * d) / K
                  const fx = (dx / d) * f
                  const fy = (dy / d) * f
                  a._dx = (a._dx || 0) + fx
                  a._dy = (a._dy || 0) + fy
                  b._dx = (b._dx || 0) - fx
                  b._dy = (b._dy || 0) - fy
                })
                // 向初始质心的弱重力，防散架
                ids.forEach((id) => {
                  const it = itemOf.get(id)
                  it._dx = (it._dx || 0) + (cx0 - it.fx) * 0.06
                  it._dy = (it._dy || 0) + (cy0 - it.fy) * 0.06
                })
                // 限步降温
                ids.forEach((id) => {
                  const it = itemOf.get(id)
                  const dx = it._dx || 0
                  const dy = it._dy || 0
                  const d = Math.hypot(dx, dy)
                  if (d > temp) {
                    it.fx += (dx / d) * temp
                    it.fy += (dy / d) * temp
                  } else {
                    it.fx += dx
                    it.fy += dy
                  }
                  it._dx = 0
                  it._dy = 0
                })
                temp = Math.max(2, temp * 0.965)
              }
            }

            // 质心归零
            let mcx = 0
            let mcy = 0
            ids.forEach((id) => {
              mcx += itemOf.get(id).fx
              mcy += itemOf.get(id).fy
            })
            mcx /= n
            mcy /= n
            ids.forEach((id) => {
              const it = itemOf.get(id)
              it.fx -= mcx
              it.fy -= mcy
            })

            // —— 按 y 聚类成行、行内按 x 排序，之后走统一收尾 ——
            // 阈值取大一些：行少一点、每行节点多一点，行内精修会自动收紧
            const sorted = ids.slice().sort((a, b) => itemOf.get(a).fy - itemOf.get(b).fy)
            const T = avgH * 0.95 + 40
            const rows = []
            let cur = []
            let curY = null
            sorted.forEach((id) => {
              const it = itemOf.get(id)
              if (curY == null || it.fy - curY > T) {
                if (cur.length) rows.push(cur)
                cur = []
                curY = it.fy
              }
              cur.push(it)
              curY = cur.reduce((s, x) => s + x.fy, 0) / cur.length
            })
            if (cur.length) rows.push(cur)
            const forceDesire = new Map()
            rows.forEach((row, r) => {
              row.sort((a, b) => a.fx - b.fx)
              row.forEach((it, i) => {
                it.row = r
                it.pos = i
                forceDesire.set(it.id, it.fx)
              })
            })

            // —— 相邻行的连线建 pred/succ 关系，跑中位数扫描降交叉 ——
            // （与分层策略同一思路：力导向只负责把关系聚成团，行内顺序
            //   交给扫描理顺，跨两行以上的连线才需要端口优化兜底）
            const rowOf = new Map()
            rows.forEach((row, r) => row.forEach((it) => rowOf.set(it.id, r)))
            const predMap = new Map()
            const succMap = new Map()
            ids.forEach((id) => {
              predMap.set(id, [])
              succMap.set(id, [])
            })
            own.forEach((e) => {
              const r1 = rowOf.get(e.from)
              const r2 = rowOf.get(e.to)
              if (r2 === r1 + 1) predMap.get(e.to).push(itemOf.get(e.from))
              if (r1 === r2 + 1) succMap.get(e.from).push(itemOf.get(e.to))
            })
            ids.forEach((id) => {
              itemOf.get(id).preds = predMap.get(id)
              itemOf.get(id).succs = succMap.get(id)
            })
            const medianF = (arr) => {
              if (!arr.length) return null
              const s2 = arr.slice().sort((a, b) => a - b)
              const m2 = s2.length >> 1
              return s2.length % 2 ? s2[m2] : (s2[m2 - 1] + s2[m2]) / 2
            }
            const resortF = (r, usePred) => {
              const row = rows[r]
              row.forEach((it) => {
                const nb = usePred ? predMap.get(it.id) : succMap.get(it.id)
                it._m = nb && nb.length ? medianF(nb.map((p) => p.pos)) : null
              })
              row.sort(
                (a, b) => (a._m === null ? a.pos : a._m) - (b._m === null ? b.pos : b._m),
              )
              row.forEach((it, i) => (it.pos = i))
            }


            return finishBlock({
              rows: rows,
              own: own,
              itemOf: itemOf,
              deg: deg,
              adjReal: adjReal,
              hPair: new Map(),
              cut: new Set(),
              canPin: false,
              useMirror: false,
              forceDesire: forceDesire,
              forcePred: predMap,
              forceSucc: succMap,
              naturalAll: true,
              rowGap: 64,
              repairs: 24,
            })
          }
        }

  return { computeCanvasLayout: computeCanvasLayout, computeRadialOrTimeline: computeRadialOrTimeline }
})
