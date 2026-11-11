// Shared harness for the front-end tests: loads the real functions out of
// index.html and runs them against a fake page and a fake backend. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

export function fn(name, src = html) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, 'function not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', m.index)), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}
export const NAMES = ['nexarRenderConfirmCard', 'nexarConfirmOpenButtons', 'nexarConfirmSnap', 'nexarConfirmSnapValid', 'nexarConfirmCardValid', 'nexarConfirmStore', 'nexarConfirmSetButtons', 'nexarConfirmShow', 'nexarConfirmOutcomeText', 'nexarConfirmResolve',
  'nexarRestorePendingConfirm', 'nexarConfirmAction', 'nexarRenderLatestDraftFromDb', 'nexarPipelineRefresh', 'nexarPipelineLoad',
  'nexarPipelineRender', 'nexarPipelineRelTime', 'nexarPipelineWriteBlocked', 'nexarPipelineAddOpen', 'nexarPipelineEditOpen',
  'nexarPipelineAddCancel', 'nexarPipelineSave', 'nexarPipelineSetStatus', 'nexarPipelineDelete',
  'nexarSend', 'nexarAbandonSend', 'nexarMarkInterrupted', 'nexarReadInterrupted', 'nexarClearInterrupted', 'nexarShowInterruptedNote',
  'nexarHandleToolCall', 'nexarHandleToolResult', 'renderNexarMessage', 'nexarFormat', 'scrollNexarBottom', 'showNexarTyping', 'hideNexarTyping',
  'nexarAutoGrow', 'nexarLoadHistory', 'renderNexarEmpty', 'nexarComputePipelineReminders',
  'nexarPipelineOwnedByCurrent', 'nexarPipelineInvalidate', 'nexarPipelineWatchAuth'];
// A top-level declaration copied out of index.html, so tests use the shipped value.
export function decl(name, src = html) {
  const m = new RegExp('(?:const|let)\\s+' + name + '\\s*=[\\s\\S]*?;\\n').exec(src);
  if (!m) { if (process.env.NEXAR_TEST_ALLOW_MISSING) return ''; throw new Error('declaration not found: ' + name); }
  return m[0];
}

// A fake Supabase client: every awaited query is passed to `backend(query)`.
export function fakeSb(backend, log, sessionUserId = () => null) {
  const authListeners = [];
  const from = (table) => {
    const q = { table, op: 'select', filters: {}, cols: null, payload: null };
    const b = new Proxy({}, { get(_, k) {
      if (k === 'then') return (res, rej) => { log.push(q); return Promise.resolve().then(() => backend(q)).then(res, rej); };
      return (...a) => {
        if (k === 'select') { q.cols = a[0]; if (q.op === 'select') q.op = 'select'; }
        else if (k === 'update' || k === 'insert') { q.op = k; q.payload = a[0]; }
        else if (k === 'delete') q.op = 'delete';
        else if (k === 'maybeSingle') q.single = true;
        else if (['eq', 'is', 'gt', 'not', 'in'].includes(k)) q.filters[a[0]] = a.length > 2 ? a[2] : a[1];
        return b;
      };
    } });
    return b;
  };
  const rpc = (name, args) => { const q = { table: 'rpc:' + name, op: 'rpc', name, args }; log.push(q); return Promise.resolve().then(() => backend(q)); };
  return { from, rpc, _authListeners: authListeners, auth: {
    getSession: async () => ({ data: { session: { access_token: 'token-for-' + sessionUserId(), user: { id: sessionUserId() } } } }),
    onAuthStateChange: (cb) => { authListeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; } } };
}

export function memoryStorage() { const m = new Map(); return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _m: m }; }
export const brokenStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
export function page({ tier = 'pro', backend = () => ({ data: [], error: null }), fetchImpl, storage = memoryStorage(), userId = 'user-1', getSession, buildContext } = {}) {
  const dom = new JSDOM(`<div id="nexar-stream"></div><textarea id="nexar-input"></textarea><button id="nexar-send-btn"></button><div id="nexar-sub-line"></div><span id="nexar-usage-text"></span><div id="nexar-upgrade-banner" style="display:none"></div>
    <div id="nexar-pipeline-locked" style="display:none"></div>
    <div id="nexar-pipeline-pro" style="display:none">
      <button id="np-add-btn"></button>
      <div id="np-form" style="display:none"><input id="np-form-id"><input id="np-form-title"><input id="np-form-company"><select id="np-form-status"><option>Applied</option><option>Interview</option></select><textarea id="np-form-notes"></textarea></div>
      <div id="np-readonly" style="display:none"><div id="np-readonly-text"></div><button id="np-readonly-upgrade"></button></div>
      <div id="np-list"></div>
      <div id="np-empty" style="display:none"><div class="np-empty-title"></div><div class="np-empty-body"></div></div>
    </div>`);
  dom.window.Element.prototype.scrollIntoView = () => {}; dom.window.Element.prototype.scrollTo = () => {};
  const modals = [];
  const log = [], toasts = [], fetches = [], drafts = [];
  const ctx = vm.createContext({
    document: dom.window.document, window: { localStorage: storage }, Number, Map, Error, TextDecoder, AbortController, requestAnimationFrame: (f) => f(),
    sanitize: (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])), nexarUpdateFabs() {}, showNexarProModal: () => modals.push(1),
    NEXAR_CHAT_URL: 'https://staging.example/functions/v1/nexar-chat', ccBuildNexarContext: async () => (buildContext ? buildContext() : { user: {} }), console: { ...console, error() {}, warn() {}, log() {} }, setTimeout, Date, Promise, String, Array, JSON, isNaN,
    confirm: () => true, showToast: (t) => toasts.push(t), currentUser: { id: userId, handle: '@amara' },
    NEXAR_FN_BASE: 'https://staging.example/functions/v1', nexarState: { tier, authVersion: 1, loadRequest: 1, authSignedOut: false, authUserId: userId, sending: false, remainingToday: null },
    fetch: async (url, init) => { fetches.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization, signal: init.signal }); return fetchImpl(url, init); },
    nexarRenderDraftBlock: (text, handle, id) => drafts.push({ text, handle, id }),
    nexarStartCheckout() {}, nexarRefreshTier: async () => {},
  });
  // The session follows whoever the page shows, unless a test sets session.userId.
  const session = { userId: undefined };
  ctx.sb = fakeSb(backend, log, () => (session.userId !== undefined ? session.userId : (ctx.currentUser ? ctx.currentUser.id : null)));
  if (getSession) ctx.sb.auth.getSession = getSession;
  vm.runInContext(`let _pipelineCache = []; let _pipelineFilter = 'all'; let _pipelineFocusMode = false; let _pipelineFocusIds = [];
    let _pipelineCanWrite = false; let _pipelineLoadFailed = false; let _pipelineCacheOwner = null; let _pipelineLoadSeq = 0; let _pipelineAuthClient = null;
    ` + decl('NEXAR_CHAT_REFUSALS') + `
    const NEXAR_REMINDER_THRESHOLDS = { Applied: 7, Responded: 3, Interview: 3, Offered: 2 };
    const nexarInterruptedMem = new Map(); let nexarSendSeq = 0; let nexarActiveSend = null;\n` + NAMES.map((n) => { try { return fn(n); } catch (e) { if (process.env.NEXAR_TEST_ALLOW_MISSING) return ''; throw e; } }).join('\n') +
    `\nglobalThis.__get = () => ({ canWrite: _pipelineCanWrite, cache: _pipelineCache, owner: _pipelineCacheOwner, failed: _pipelineLoadFailed });`, ctx);
  const $ = (s) => dom.window.document.querySelector(s);
  const card = () => { const c = $('.nexar-confirm-card:last-child'); return { el: c, state: c.dataset.state, body: c.querySelector('.ncc-body').textContent,
    meta: c.querySelector('.ncc-meta').textContent, buttons: [...c.querySelectorAll('.ncc-btn')].map(b => b.textContent) }; };
  return { ctx, dom, $, log, toasts, fetches, drafts, card, storage, modals, session, authEvent: (event, s) => ctx.sb._authListeners.forEach((cb) => cb(event, s)), run: (code) => vm.runInContext(code, ctx) };
}
export const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
export const REQ = `{ action_id: '11111111-1111-4111-8111-111111111111', preview: 'Delete "Design system clean-up" @ Tidewater Studio (Applied)?', expires_at: new Date(Date.now() + 600000).toISOString() }`;
export const JOBS = [{ id: 'j1', title: 'Product designer', company: 'Lanternworks', status: 'Applied', notes: '', updated_at: new Date().toISOString() }];
export const jobsBackend = (q) => q.table === 'nexar_pipeline' && q.op === 'select' ? { data: JOBS, error: null } : { data: [], error: null };

