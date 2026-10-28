/* Shared form transport. No personal data or tokens are saved in browser storage. */
(function (root) {
  'use strict';
  function createSubmission(options = {}) {
    let pending = false, previous = null;
    return {
      get pending() { return pending; },
      async send(fields) {
        if (pending) throw new Error('Отправка уже выполняется.');
        const endpoint = options.endpoint === undefined ? root.ITD_FORMS_ENDPOINT : options.endpoint;
        let url;
        try { url = new URL(endpoint); } catch { throw new Error('Не удалось отправить данные. Попробуйте ещё раз.'); }
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash || /(^|\.)(make\.com|integromat\.com)$/i.test(url.hostname))
          throw new Error('Не удалось отправить данные. Попробуйте ещё раз.');
        if (fields.consent !== true || fields.website) throw new Error('Проверьте согласие и данные формы.');
        const normalized = JSON.parse(JSON.stringify({...fields, source_site: 'itdstudio.ru'}));
        delete normalized.request_id; delete normalized.submitted_at;
        const fingerprint = JSON.stringify(normalized);
        if (!previous || previous.fingerprint !== fingerprint) {
          let uuid;
          if (root.crypto.randomUUID) uuid = root.crypto.randomUUID();
          else {
            const bytes = root.crypto.getRandomValues(new Uint8Array(16));
            bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
            const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
            uuid = [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
          }
          previous = {fingerprint, payload: {...normalized, request_id: uuid, submitted_at: new Date().toISOString()}};
        }
        if (previous.accepted) return previous.accepted;
        pending = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || 25000);
        try {
          const response = await (options.fetch || root.fetch.bind(root))(url.href, {
            method: 'POST', headers: {'Content-Type': 'application/json'}, credentials: 'omit',
            body: JSON.stringify(previous.payload), signal: controller.signal, cache: 'no-store', redirect: 'error'
          });
          if (response.status !== 200) throw new Error('Delivery not confirmed');
          const result = await response.json();
          if (result.ok !== true || result.request_id !== previous.payload.request_id) throw new Error('Delivery not confirmed');
          previous.accepted = result;
          return result;
        } finally { clearTimeout(timer); pending = false; }
      }
    };
  }
  root.ITDForms = {createSubmission};
  if (typeof module !== 'undefined' && module.exports) module.exports = {createSubmission};
})(typeof window !== 'undefined' ? window : globalThis);
