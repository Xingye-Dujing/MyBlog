/* OMM-ZEN 产品共用的字节编码与密钥派生工具。 */
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

  root.ZenCrypto = {
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    deriveKey: deriveKey,
  };
})(typeof window !== 'undefined' ? window : globalThis);
