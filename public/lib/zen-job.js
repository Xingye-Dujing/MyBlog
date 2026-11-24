/* OMM-ZEN lib · job runtime
 * ------------------------------------------------------------------
 * The backend job protocol shared by the canvas products (table, video):
 * JSON job submission, cancel, and "insert node at viewport centre".
 *
 * Exposes: window.ZenJob
 * Depends: zen/foundation/util.js is not required; callers inject the toast
 * callback and their canvas instance so this module stays stateless.
 */
;(function (global) {
  'use strict'
  var job = (global.ZenJob = global.ZenJob || {})

  /* POST a job request. `raw` sends the body as octet-stream for uploads. */
  job.post = function (api, path, body, raw) {
    return fetch(api + path, {
      method: 'POST',
      headers: raw
        ? { 'Content-Type': 'application/octet-stream' }
        : { 'Content-Type': 'application/json' },
      body: raw ? body : JSON.stringify(body || {}),
    }).then(function (r) { return r.json() })
  }

  /* Cancel the running job; no request when nothing is running. */
  job.cancel = function (api, jobId, toast) {
    if (!jobId) return
    return job.post(api, '/api/cancel/' + jobId, {}).then(function () {
      toast('已请求停止')
    })
  }

  /* Insert a node at the centre of the visible canvas, cascade-offset by index
   * so repeated inserts do not stack on one point. */
  job.addAtCenter = function (opts) {
    var o = opts
    var rect = document.getElementById(o.host).getBoundingClientRect()
    var w = o.canvas.screenToWorld(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    )
    var n = o.canvas.state.nodes.length
    var rec = o.canvas.addNode(o.type, {}, {
      x: w.x - 120 + (n % 3) * 28,
      y: w.y - 60 + (n % 3) * 24,
    })
    o.canvas.select(rec.id)
    o.toast('已添加“' + o.label + '”')
  }
})(window)
