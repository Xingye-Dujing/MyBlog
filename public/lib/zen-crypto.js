/* OMM-ZEN 产品共用的字节编码、密钥派生与 AES-GCM 信封工具。 */
(function (root) {
  'use strict';

  function bytesToBase64(bytes) {
    var a = new Uint8Array(bytes);
    var s = '';
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }

  function base64ToBytes(s) {
    var b = atob(s);
    var a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a.buffer;
  }

  function deriveKey(pw, salt) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: 310000, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      });
  }

  function message(value, fallback) {
    return (typeof value === 'function' ? value() : value) || fallback;
  }

  /* AES-GCM envelope: wrap arbitrary JSON data into a storable string.
   * The envelope layout is identical for every consumer
   * ({v, alg, kdf, iter, salt, iv, cipher}); product-specific concerns are
   * injected through opts — no product branch lives here.
   *   version / accept : envelope version written / accepted on read
   *   normalize        : transform the payload before seal / after unseal
   *   validate         : reject an unacceptable normalized payload
   *   encode / decode  : inner plaintext codec (defaults to JSON {v,data})
   *   msgUnsupported / msgInvalid : error text (string or thunk for i18n)
   */
  function seal(data, pw, opts) {
    var o = opts || {};
    var version = o.version == null ? 1 : o.version;
    var body = typeof o.normalize === 'function' ? o.normalize(data) : data;
    var plain = typeof o.encode === 'function'
      ? o.encode(body, version)
      : JSON.stringify({ v: version, data: body });
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pw, salt).then(function (k) {
      return crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(plain)
      );
    }).then(function (ct) {
      return JSON.stringify({
        v: version,
        alg: 'AES-GCM',
        kdf: 'PBKDF2-SHA256',
        iter: 310000,
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        cipher: bytesToBase64(ct),
      });
    });
  }

  function unseal(payload, pw, opts) {
    var o = opts || {};
    var box = typeof payload === 'string' ? JSON.parse(payload) : payload;
    var accept = o.accept || [o.version == null ? 1 : o.version];
    if (!box || accept.indexOf(box.v) < 0 || box.alg !== 'AES-GCM') {
      throw new Error(message(o.msgUnsupported, '云端数据格式不支持'));
    }
    var salt = new Uint8Array(base64ToBytes(box.salt));
    var iv = new Uint8Array(base64ToBytes(box.iv));
    var cipher = new Uint8Array(base64ToBytes(box.cipher));
    return deriveKey(pw, salt).then(function (k) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, k, cipher);
    }).then(function (pt) {
      var text = new TextDecoder().decode(pt);
      var data = typeof o.decode === 'function'
        ? o.decode(text)
        : (function () { var x = JSON.parse(text); return x && x.data })();
      if (typeof o.normalize === 'function') data = o.normalize(data);
      if (typeof o.validate === 'function' && !o.validate(data)) {
        throw new Error(message(o.msgInvalid, '云端数据无效'));
      }
      return data;
    });
  }

  root.ZenCrypto = {
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    deriveKey: deriveKey,
    seal: seal,
    unseal: unseal,
  };
})(typeof window !== 'undefined' ? window : globalThis);
