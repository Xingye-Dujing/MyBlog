/* OMM-ZEN UI · components/popover
 * ------------------------------------------------------------------
 * The shared mechanics of an anchored popover: viewport-aware placement,
 * one-open-at-a-time, and outside-click / Escape close through the shared
 * layer stack. Content and product-specific side effects stay in the product
 * and are passed through generic options / callbacks — never product branches.
 *
 * API: ZenUI.popover.open(el, anchor, opts) -> close function
 *      ZenUI.popover.close([el])   // optionally close only a specific element
 *      ZenUI.popover.closeAll()
 * opts (all generic):
 *   x, y            absolute position override (numbers or CSS strings)
 *   top             raw CSS top override (e.g. a calc() expression)
 *   align           'left' | 'center' | 'right'  (default 'left')
 *   side            'right' | 'left' — place outside the anchor, flipping if needed
 *   valign          'top' | 'center' | bottom-anchored (default)
 *   gap             distance from anchor (default 4)
 *   pad             viewport padding (default 8)
 *   padTop/padBottom asymmetric viewport padding
 *   flip            place above the anchor when there is not enough room below
 *   flipMin         minimum top when flipped (default: padTop)
 *   clampTop        clamp a valign:'top' result into the viewport
 *   activeClass     class toggled on the anchor while open
 *   closeOnWheel    close when the user scrolls outside
 *   onOpen/onClose  hooks(el) for product-owned side effects
 * Depends: zen/components/layer.js (load after it)
 */
;(function (global) {
  'use strict'
  var ui = (global.ZenUI = global.ZenUI || {})
  var layer = ui.layer
  if (!layer) throw new Error('zen/ui: layer.js must load before popover.js')

  var active = null

  function css(v) { return typeof v === 'number' ? Math.round(v) + 'px' : v }

  function place(el, anchor, opts) {
    var w = el.offsetWidth || 160
    var h = el.offsetHeight || 120
    var pad = opts.pad != null ? opts.pad : 8
    var gap = opts.gap != null ? opts.gap : 4
    var topPad = opts.padTop != null ? opts.padTop : pad
    var bottomPad = opts.padBottom != null ? opts.padBottom : pad
    var left = opts.x
    var top = opts.top != null ? opts.top : opts.y
    if (anchor && anchor.getBoundingClientRect) {
      var r = anchor.getBoundingClientRect()
      if (left == null) {
        if (opts.side === 'right' || opts.side === 'left') {
          var right = opts.side === 'right'
          left = right ? r.right + gap : r.left - w - gap
          var overflow = right ? left + w > global.innerWidth - pad : left < pad
          if (overflow) left = right ? r.left - w - gap : r.right + gap
        } else {
          left = opts.align === 'center' ? r.left + r.width / 2 - w / 2
            : opts.align === 'right' ? r.right - w : r.left
        }
        left = Math.max(pad, Math.min(left, global.innerWidth - w - pad))
      }
      if (top == null) {
        if (opts.valign === 'top') top = r.top
        else if (opts.valign === 'center') top = r.top + r.height / 2 - h / 2
        else top = r.bottom + gap
        if (opts.flip && top + h > global.innerHeight - bottomPad) {
          top = Math.max(opts.flipMin != null ? opts.flipMin : topPad, r.top - h - gap)
        } else if (opts.clampTop || opts.valign) {
          top = Math.max(topPad, Math.min(top, global.innerHeight - h - bottomPad))
        }
      }
    }
    if (left != null) el.style.left = css(left)
    if (top != null) el.style.top = css(top)
  }

  function close(el) {
    if (!active) return
    if (el && active.el !== el) return
    var job = active
    active = null
    var l = layer.get()
    job.el.classList.remove('open')
    if (job.anchor && job.opts.activeClass) job.anchor.classList.remove(job.opts.activeClass)
    if (job.entry) l.pop(job.entry)
    if (job.onWheel) global.removeEventListener('wheel', job.onWheel, true)
    l.closePopover = null
    if (job.opts.onClose) job.opts.onClose(job.el)
  }

  function open(el, anchor, opts) {
    if (!el) return function () {}
    opts = opts || {}
    close()
    var l = layer.get()
    active = { el: el, anchor: anchor, opts: opts, entry: null, onWheel: null }
    el.classList.add('open')
    if (anchor && opts.activeClass && anchor.classList) anchor.classList.add(opts.activeClass)
    place(el, anchor, opts)

    var entry = {
      outside: function (event) {
        if (!active || active.el !== el) return
        var path = event.composedPath ? event.composedPath() : [event.target]
        if (path.indexOf(el) >= 0) return
        if (anchor && path.indexOf(anchor) >= 0) return
        close(el)
      },
      escape: function () { close(el) },
    }
    active.entry = entry
    l.push(entry)
    l.closePopover = function () { close(el) }
    if (opts.closeOnWheel) {
      active.onWheel = function (event) {
        if (!active || active.el !== el) return
        var path = event.composedPath ? event.composedPath() : [event.target]
        if (path.indexOf(el) >= 0) return
        close(el)
      }
      global.addEventListener('wheel', active.onWheel, true)
    }
    if (opts.onOpen) opts.onOpen(el)
    return function () { close(el) }
  }

  ui.popover = { open: open, close: close, closeAll: close, place: place }
})(window)
