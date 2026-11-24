/* OMM-ZEN lib · job runtime
 * ------------------------------------------------------------------
 * The backend job protocol shared by the canvas products (table, video):
 * JSON submission, cancellation, one polling state machine, and insertion at
 * the viewport centre.
 *
 * Exposes: window.ZenJob
 */
;(function (global) {
  'use strict'
  var job = (global.ZenJob = global.ZenJob || {})
  var TERMINAL = { done: true, error: true, cancelled: true, failed: true, missing: true }

  function messageOf(error, fallback) {
    if (!error) return fallback || '请求失败'
    if (typeof error === 'string') return error
    var payload = error.payload || {}
    var detail = payload.error || error.message || fallback
    if (detail && typeof detail === 'object') detail = detail.message || JSON.stringify(detail)
    if (error.status === 404) return detail || '任务不存在或已回收'
    if (error.status === 409) return detail || '任务状态已变化，请刷新后重试'
    if (error.status === 413) return detail || '请求内容超过大小限制'
    if (error.status >= 500) return detail || '后端暂时不可用，请稍后重试'
    return detail || fallback || '请求失败'
  }
  job.message = messageOf

  function request(path, options) {
    return fetch(path, options).then(function (response) {
      return response.text().then(function (text) {
        var data = {}
        var parsed = true
        if (text) {
          try { data = JSON.parse(text) } catch (_) { parsed = false }
        } else {
          data = { ok: true }
        }
        if (!response.ok || !parsed || !data || typeof data !== 'object' || data.ok === false) {
          var error = new Error(messageOf({ status: response.status, payload: data }, '请求失败'))
          error.status = response.status
          error.payload = data
          throw error
        }
        return data
      })
    })
  }

  /* Unified HTTP + JSON error handling for every backend call. */
  job.get = function (api, path) {
    return request(api + path, { headers: { Accept: 'application/json' } })
  }

  /* POST a job request. `raw` sends the body as octet-stream for uploads. */
  job.post = function (api, path, body, raw) {
    return request(api + path, {
      method: 'POST',
      headers: raw
        ? { 'Content-Type': 'application/octet-stream' }
        : { 'Content-Type': 'application/json' },
      body: raw ? body : JSON.stringify(body || {}),
    })
  }

  /* Cancel only a live job; backend rejection is surfaced to the caller. */
  job.cancel = function (api, jobId, toast) {
    if (!jobId) return Promise.reject(new Error('没有运行中的任务'))
    return job.post(api, '/api/cancel/' + encodeURIComponent(jobId), {}).then(function (result) {
      if (result.cancelled !== true) throw new Error('后端未确认取消')
      if (toast) toast('已请求停止')
      return result
    })
  }

  /* One polling state machine for both products. Duplicate ticks share the
   * in-flight request; a missing job is terminal, transient failures retry. */
  job.poll = function (api, jobId, handlers) {
    var callbacks = handlers || {}
    var timer = null
    var active = true
    var inFlight = false
    var finished = false
    var failures = 0

    function clear() {
      if (timer != null) global.clearTimeout(timer)
      timer = null
    }
    function schedule(delay) {
      clear()
      if (active) timer = global.setTimeout(tick, delay)
    }
    function finish(snapshot, error) {
      if (finished) return
      finished = true
      active = false
      clear()
      if (callbacks.onFinish) callbacks.onFinish(snapshot, error)
    }
    function tick() {
      if (!active || finished || inFlight) return
      inFlight = true
      job.get(api, '/api/job/' + encodeURIComponent(jobId)).then(function (snapshot) {
        if (!active) return
        inFlight = false
        if (callbacks.onState) callbacks.onState(snapshot)
        if (TERMINAL[snapshot.status]) {
          finish(snapshot)
        } else {
          failures = 0
          schedule(600)
        }
      }).catch(function (error) {
        if (!active) return
        inFlight = false
        if (error && error.status === 404) {
          finish(null, error)
          return
        }
        failures += 1
        if (callbacks.onError) callbacks.onError(error, failures)
        schedule(Math.min(5000, 600 * failures))
      })
    }

    tick()
    return {
      stop: function () {
        active = false
        clear()
      },
    }
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
