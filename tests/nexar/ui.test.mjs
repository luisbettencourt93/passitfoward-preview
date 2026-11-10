// Front-end tests. They load the real functions out of index.html and run them
// against a fake page and a fake backend. No network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function fn(name, src = html) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, 'function not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', m.index)), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}
const NAMES = ['nexarRenderConfirmCard', 'nexarConfirmOpenButtons', 'nexarConfirmSnap', 'nexarConfirmSnapValid', 'nexarConfirmCardValid', 'nexarConfirmStore', 'nexarConfirmSetButtons', 'nexarConfirmShow', 'nexarConfirmOutcomeText', 'nexarConfirmResolve',
  'nexarRestorePendingConfirm', 'nexarConfirmAction', 'nexarRenderLatestDraftFromDb', 'nexarPipelineRefresh', 'nexarPipelineLoad',
  'nexarPipelineRender', 'nexarPipelineRelTime', 'nexarPipelineWriteBlocked', 'nexarPipelineAddOpen', 'nexarPipelineEditOpen',
  'nexarPipelineAddCancel', 'nexarPipelineSave', 'nexarPipelineSetStatus', 'nexarPipelineDelete'];

// A fake Supabase client: every awaited query is passed to `backend(query)`.
function fakeSb(backend, log) {
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
  return { from, rpc, auth: { getSession: async () => ({ data: { session: { access_token: 'staging-token' } } }) } };
}

function memoryStorage() { const m = new Map(); return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _m: m }; }
const brokenStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
function page({ tier = 'pro', backend = () => ({ data: [], error: null }), fetchImpl, storage = memoryStorage(), userId = 'user-1' } = {}) {
  const dom = new JSDOM(`<div id="nexar-stream"></div>
    <div id="nexar-pipeline-locked" style="display:none"></div>
    <div id="nexar-pipeline-pro" style="display:none">
      <button id="np-add-btn"></button>
      <div id="np-form" style="display:none"><input id="np-form-id"><input id="np-form-title"><input id="np-form-company"><select id="np-form-status"><option>Applied</option><option>Interview</option></select><textarea id="np-form-notes"></textarea></div>
      <div id="np-readonly" style="display:none"><div id="np-readonly-text"></div><button id="np-readonly-upgrade"></button></div>
      <div id="np-list"></div>
      <div id="np-empty" style="display:none"><div class="np-empty-title"></div><div class="np-empty-body"></div></div>
    </div>`);
  dom.window.Element.prototype.scrollIntoView = () => {};
  const log = [], toasts = [], fetches = [], drafts = [];
  const ctx = vm.createContext({
    document: dom.window.document, window: { localStorage: storage }, Number, console: { ...console, error() {}, warn() {} }, setTimeout, Date, Promise, String, Array, JSON, isNaN,
    confirm: () => true, showToast: (t) => toasts.push(t), currentUser: { id: userId, handle: '@amara' },
    NEXAR_FN_BASE: 'https://staging.example/functions/v1', nexarState: { tier, authVersion: 1, loadRequest: 1, authSignedOut: false, authUserId: userId },
    fetch: async (url, init) => { fetches.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return fetchImpl(url, init); },
    nexarRenderDraftBlock: (text, handle, id) => drafts.push({ text, handle, id }),
    nexarStartCheckout() {}, nexarRefreshTier: async () => {},
  });
  ctx.sb = fakeSb(backend, log);
  vm.runInContext(`let _pipelineCache = []; let _pipelineFilter = 'all'; let _pipelineFocusMode = false; let _pipelineFocusIds = [];
    let _pipelineCanWrite = false; let _pipelineLoadFailed = false;\n` + NAMES.map((n) => fn(n)).join('\n') +
    `\nglobalThis.__get = () => ({ canWrite: _pipelineCanWrite, cache: _pipelineCache });`, ctx);
  const $ = (s) => dom.window.document.querySelector(s);
  const card = () => { const c = $('.nexar-confirm-card:last-child'); return { el: c, state: c.dataset.state, body: c.querySelector('.ncc-body').textContent,
    meta: c.querySelector('.ncc-meta').textContent, buttons: [...c.querySelectorAll('.ncc-btn')].map(b => b.textContent) }; };
  return { ctx, dom, $, log, toasts, fetches, drafts, card, storage, run: (code) => vm.runInContext(code, ctx) };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const REQ = `{ action_id: '11111111-1111-4111-8111-111111111111', preview: 'Delete "Design system clean-up" @ Tidewater Studio (Applied)?', expires_at: new Date(Date.now() + 600000).toISOString() }`;
const JOBS = [{ id: 'j1', title: 'Product designer', company: 'Lanternworks', status: 'Applied', notes: '', updated_at: new Date().toISOString() }];
const jobsBackend = (q) => q.table === 'nexar_pipeline' && q.op === 'select' ? { data: JOBS, error: null } : { data: [], error: null };

// ---- Environment routing ------------------------------------------------------
test('no backend address is written into a function call; confirm uses the configured base', async () => {
  assert.equal((html.match(/https:\/\/[a-z0-9]{20}\.supabase\.co\/functions/g) || []).length, 0);
  const p = page({ fetchImpl: async () => res(200, { ok: true, action: 'cancelled' }) });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', false, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(p.fetches[0].url, 'https://staging.example/functions/v1/nexar-confirm-action');
  assert.deepEqual(p.fetches[0].body, { action_id: '11111111-1111-4111-8111-111111111111', accept: false });
});
test('staging safeguards and PR22 code are untouched', () => {
  assert.match(html, /let PIF_ENV = 'staging';/);
  assert.match(html, /const NEXAR_FN_BASE = `\$\{SUPABASE_URL\}\/functions\/v1`;/);
  const pr22 = execFileSync('git', ['-C', root, 'show', 'pr/22:index.html'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const name of ['loadNexar', 'nexarRefreshTier', 'nexarSend', 'nexarHandleToolResult', 'ccBuildNexarContext']) assert.equal(fn(name), fn(name, pr22), name + ' changed');
});

// ---- Draft attribution -------------------------------------------------------
test('a restored draft is labelled with the poster of its own opportunity, never a fixed handle', async () => {
  assert.equal(/nexarRenderDraftBlock\(\s*data\.draft_text,\s*'@/.test(html), false);
  const p = page({ backend: () => ({ data: { id: 'm1', draft_text: 'Hello', opportunities: { poster_handle: '@lanternworks' } }, error: null }) });
  await p.run('nexarRenderLatestDraftFromDb()');
  assert.deepEqual(p.drafts, [{ text: 'Hello', handle: '@lanternworks', id: 'm1' }]);
  assert.equal(p.log[0].filters.user_id, 'user-1'); assert.match(p.log[0].cols, /opportunities\(poster_handle\)/);
  const q = page({ backend: () => ({ data: { id: 'm2', draft_text: 'Hi', opportunities: null }, error: null }) });
  await q.run('nexarRenderLatestDraftFromDb()');
  assert.equal(q.drafts[0].handle, '');   // the block then shows "opportunity poster"
});

// ---- Delete confirmation -------------------------------------------------------
test('recorded outcomes map to wording that claims only what the server recorded', () => {
  const p = page();
  const t = (row) => p.run(`nexarConfirmOutcomeText(${JSON.stringify(row)})`);
  assert.equal(t({ outcome: 'deleted', consumed_at: 'x' })[0], 'Deleted.');
  assert.match(t({ outcome: 'cancelled', consumed_at: 'x' })[1], /did not delete/);
  assert.match(t({ outcome: 'superseded', consumed_at: 'x' })[0], /Replaced/);
  assert.match(t({ outcome: 'target_changed', consumed_at: 'x' })[0], /changed after you asked/);
  assert.equal(t({ outcome: null, consumed_at: null, expires_at: new Date(Date.now() - 3600000).toISOString() }), null, 'a passed deadline alone settles nothing');
  assert.match(t({ outcome: 'expired', consumed_at: 'x' })[0], /expired/);
  assert.equal(/Date\.now|new Date/.test(fn('nexarConfirmOutcomeText')), false, 'the outcome text never reads the clock');
  assert.equal(t({ outcome: null, consumed_at: null, expires_at: new Date(Date.now() + 60000).toISOString() }), null, 'an open request has no outcome');
  for (const o of ['cancelled', 'superseded', 'target_changed', 'expired']) assert.equal(/No changes|unchanged|still in your/i.test(t({ outcome: o, consumed_at: 'x' }).join(' ')), false);
});
test('server confirms delete: card resolves and names the deleted job', async () => {
  const p = page({ backend: jobsBackend, fetchImpl: async () => res(200, { ok: true, action: 'deleted', target: { title: 'Design system clean-up', company: 'Tidewater Studio' } }) });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  assert.deepEqual(p.card().buttons, ['KEEP JOB', 'DELETE']); assert.match(p.card().meta, /expires at/);
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', true, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(p.card().state, 'resolved'); assert.match(p.card().body, /Deleted: Design system clean-up @ Tidewater Studio/); assert.deepEqual(p.card().buttons, []);
});
test('job changed after the request: nothing deleted, current job shown', async () => {
  const p = page({ fetchImpl: async () => res(409, { ok: false, error: 'target_changed', current: { title: 'Design system clean-up', company: 'Tidewater Studio', status: 'Interview' } }) });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', true, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(p.card().state, 'resolved'); assert.match(p.card().meta, /\(Interview\)/); assert.match(p.card().meta, /did not delete/);
});
test('losing a competing answer: the card shows what the server recorded', async () => {
  const p = page({ backend: (q) => q.op === 'rpc' ? { data: { found: true, id: 'x', consumed_at: 'now', outcome: 'cancelled' }, error: null } : jobsBackend(q),
    fetchImpl: async () => res(409, { ok: false, error: 'already_resolved', outcome: 'cancelled' }) });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', true, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(p.card().state, 'resolved'); assert.equal(p.card().body, 'Request cancelled.');
});
test('no response: stays "not confirmed", never offers the opposite answer, then resolves from the record', async () => {
  let row = { found: true, id: 'x', consumed_at: null, outcome: null, expires_at: new Date(Date.now() + 600000).toISOString() };
  const p = page({ backend: (q) => q.op === 'rpc' ? { data: row, error: null } : jobsBackend(q), fetchImpl: async () => { throw new Error('network'); } });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', true, document.querySelector('.nexar-confirm-card'))`);
  let c = p.card();
  assert.equal(c.state, 'uncertain'); assert.equal(c.body, 'Not confirmed yet.'); assert.match(c.meta, /do not know yet/);
  assert.deepEqual(c.buttons, ['CHECK AGAIN', 'SEND DELETE AGAIN']);
  // the opposite answer is refused in code as well as hidden
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', false, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(p.fetches.length, 1, 'no second call with a different answer');
  // an unchanged job proves nothing: only the request record settles it
  row = { ...row, consumed_at: 'now', outcome: 'deleted' };
  await p.run(`nexarConfirmResolve(document.querySelector('.nexar-confirm-card'))`);
  c = p.card(); assert.equal(c.state, 'resolved'); assert.equal(c.body, 'Deleted.');
});
test('the record cannot be read: says so and offers only "check again"', async () => {
  const p = page({ backend: (q) => q.op === 'rpc' ? { data: null, error: { message: 'x' } } : jobsBackend(q), fetchImpl: async () => res(500, { error: 'confirm_failed' }) });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', true, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(p.card().state, 'uncertain'); assert.deepEqual(p.card().buttons, ['CHECK AGAIN']); assert.match(p.card().meta, /do not know yet/);
});
test('a newer request marks the older card as replaced', async () => {
  const p = page({ backend: (q) => q.op === 'rpc' ? { data: { found: true, id: 'old', consumed_at: 'now', outcome: 'superseded' }, error: null } : jobsBackend(q) });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  p.run(`nexarRenderConfirmCard({ action_id: '22222222-2222-4222-8222-222222222222', preview: 'Delete?', expires_at: new Date(Date.now() + 600000).toISOString() })`);
  await new Promise((r) => setTimeout(r, 20));
  const cards = [...p.dom.window.document.querySelectorAll('.nexar-confirm-card')];
  assert.equal(cards[0].dataset.state, 'resolved'); assert.match(cards[0].querySelector('.ncc-body').textContent, /Replaced by a newer request/);
  assert.equal(cards[1].dataset.state, 'open');
});
test('after a reload, open requests are restored once each', async () => {
  const rows = [{ id: '33333333-3333-4333-8333-333333333333', preview: 'Delete "A" @ B (Applied)?', expires_at: new Date(Date.now() + 300000).toISOString(), action_type: 'delete_pipeline' }];
  const p = page({ backend: (q) => q.table === 'nexar_pending_actions' && q.cols.includes('preview') ? { data: rows, error: null } : { data: null, error: null } });
  await p.run('nexarRestorePendingConfirm()'); await p.run('nexarRestorePendingConfirm()');
  assert.equal(p.dom.window.document.querySelectorAll('.nexar-confirm-card').length, 1);
  assert.equal(p.log[0].filters.user_id, 'user-1'); assert.equal(p.log[0].filters.consumed_at, null);
});

// ---- Regression: review round 2 ---------------------------------------------------
const ID = '11111111-1111-4111-8111-111111111111';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const OPEN_ROWS = [{ id: ID, preview: 'Delete "A" @ B (Applied)?', expires_at: new Date(Date.now() + 300000).toISOString(), action_type: 'delete_pipeline' }];
const cards = (p) => [...p.dom.window.document.querySelectorAll('.nexar-confirm-card')];

test('R1 account switch while the restore read is in flight: nothing from the earlier member is shown', async () => {
  for (const change of [
    `currentUser = { id: 'user-2' }; nexarState.authVersion++; nexarState.authUserId = 'user-2';`,   // different member signed in
    `nexarState.authVersion++; nexarState.authSignedOut = true;`,                                     // signed out
    `sb = { ...sb };`,                                                                                // connection replaced
    `nexarState.loadRequest++;`,                                                                      // a newer load started
  ]) {
    const gate = deferred();
    const p = page({ backend: (q) => q.table === 'nexar_pending_actions' ? gate.promise : { data: [], error: null } });
    const pending = p.run('nexarRestorePendingConfirm()');
    await new Promise((r) => setTimeout(r, 5));
    p.run(change + ` document.getElementById('nexar-stream').textContent = '';`);
    gate.resolve({ data: OPEN_ROWS, error: null });
    await pending;
    assert.equal(cards(p).length, 0, 'rendered after: ' + change);
  }
  const ok = page({ backend: (q) => q.table === 'nexar_pending_actions' ? { data: OPEN_ROWS, error: null } : { data: [], error: null } });
  await ok.run('nexarRestorePendingConfirm()');
  assert.equal(cards(ok).length, 1, 'the unchanged account still gets its card');
});
test('R1 a check or an answer that finishes after an account switch changes nothing on screen', async () => {
  const gate = deferred(); const net = deferred();
  const p = page({ backend: (q) => q.op === 'rpc' ? gate.promise : jobsBackend(q), fetchImpl: () => net.promise });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  const c = cards(p)[0];
  const r1 = p.run(`nexarConfirmResolve(document.querySelector('.nexar-confirm-card'))`);
  p.run(`currentUser = { id: 'user-2' }; nexarState.authVersion++; nexarState.authUserId = 'user-2';`);
  gate.resolve({ data: { found: true, consumed_at: 'now', outcome: 'deleted' }, error: null });
  await r1;
  assert.equal(c.dataset.state, 'open'); assert.match(c.querySelector('.ncc-body').textContent, /^Delete "/);
  assert.equal(p.log.filter(q => q.table === 'nexar_pipeline').length, 0, 'no Pipeline reload for the new account');
  await p.run(`nexarConfirmAction('${ID}', true, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(p.fetches.length, 0, 'a card from another account cannot send an answer');
});
test('R2 a passed deadline on this device never produces "expired": only the server record does', async () => {
  let row = { found: true, consumed_at: null, outcome: null, expires_at: new Date(Date.now() - 60000).toISOString() };   // already past locally
  const p = page({ backend: (q) => q.op === 'rpc' ? { data: row, error: null } : jobsBackend(q), fetchImpl: async () => { throw new Error('network'); } });
  p.run(`nexarRenderConfirmCard({ action_id: '${ID}', preview: 'Delete?', expires_at: '${row.expires_at}' })`);
  await p.run(`nexarConfirmAction('${ID}', true, document.querySelector('.nexar-confirm-card'))`);
  let c = p.card();
  assert.equal(c.state, 'uncertain'); assert.equal(/expired|did not delete/i.test(c.body + c.meta), false);
  assert.equal(p.log.some(q => q.name === 'nexar_settle_pending_action' && q.args.p_action_id === ID), true, 'asks the server');
  row = { ...row, consumed_at: 'now', outcome: 'deleted' };                // the original answer completed after the deadline
  await p.run(`nexarConfirmResolve(document.querySelector('.nexar-confirm-card'))`);
  c = p.card(); assert.equal(c.state, 'resolved'); assert.equal(c.body, 'Deleted.');
});
test('R4 an older "still open" read cannot replace a confirmed result', async () => {
  const gate = deferred();
  const p = page({ backend: (q) => q.op === 'rpc' ? gate.promise : jobsBackend(q),
    fetchImpl: async () => res(200, { ok: true, action: 'deleted', target: { title: 'Design system clean-up', company: 'Tidewater Studio' } }) });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  const older = p.run(`nexarConfirmResolve(document.querySelector('.nexar-confirm-card'))`);       // read starts first
  await p.run(`nexarConfirmAction('${ID}', true, document.querySelector('.nexar-confirm-card'))`); // deletion confirmed
  assert.equal(p.card().state, 'resolved');
  gate.resolve({ data: { found: true, consumed_at: null, outcome: null, expires_at: new Date(Date.now() + 600000).toISOString() }, error: null });
  await older;
  const c = p.card();
  assert.equal(c.state, 'resolved'); assert.match(c.body, /^Deleted: /); assert.deepEqual(c.buttons, []);
});
test('R4 reads returning out of order: the newest read decides, and a recorded outcome always wins', async () => {
  const g1 = deferred(), g2 = deferred(); let n = 0;
  const p = page({ backend: (q) => q.op === 'rpc' ? (++n === 1 ? g1.promise : n === 2 ? g2.promise : { data: null, error: { message: 'x' } }) : jobsBackend(q), fetchImpl: async () => { throw new Error('network'); } });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  const open = { found: true, consumed_at: null, outcome: null, expires_at: new Date(Date.now() + 600000).toISOString() };
  const a = p.run(`nexarConfirmResolve(document.querySelector('.nexar-confirm-card'))`);
  const b = p.run(`nexarConfirmResolve(document.querySelector('.nexar-confirm-card'))`);
  g2.resolve({ data: { ...open, consumed_at: 'now', outcome: 'cancelled' }, error: null }); await b;
  g1.resolve({ data: open, error: null }); await a;
  assert.equal(p.card().state, 'resolved'); assert.equal(p.card().body, 'Request cancelled.');
  // and a late terminal read still lands on a card that a newer read left "not confirmed"
  const q1 = deferred(), q2 = deferred(); let m = 0;
  const p2 = page({ backend: (q) => q.op === 'rpc' ? (++m === 1 ? { data: open, error: null } : m === 2 ? q1.promise : q2.promise) : jobsBackend(q), fetchImpl: async () => { throw new Error('network'); } });
  p2.run(`nexarRenderConfirmCard(${REQ})`);
  await p2.run(`nexarConfirmAction('${ID}', true, document.querySelector('.nexar-confirm-card'))`);
  const x = p2.run(`nexarConfirmResolve(document.querySelector('.nexar-confirm-card'))`);
  const y = p2.run(`nexarConfirmResolve(document.querySelector('.nexar-confirm-card'))`);
  q2.resolve({ data: open, error: null }); await y;
  q1.resolve({ data: { ...open, consumed_at: 'now', outcome: 'deleted' }, error: null }); await x;
  assert.equal(p2.card().state, 'resolved'); assert.equal(p2.card().body, 'Deleted.');
});
test('R5 after an unconfirmed Delete, a reload keeps the restriction to that answer', async () => {
  const storage = memoryStorage();
  const open = { found: true, consumed_at: null, outcome: null, expires_at: OPEN_ROWS[0].expires_at };
  const backend = (q) => q.op === 'rpc' ? { data: open, error: null } : q.table === 'nexar_pending_actions' ? { data: OPEN_ROWS, error: null } : jobsBackend(q);
  const first = page({ storage, backend, fetchImpl: async () => { throw new Error('network'); } });
  first.run(`nexarRenderConfirmCard(${REQ})`);
  await first.run(`nexarConfirmAction('${ID}', true, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(storage.getItem('nexar.confirm.user-1.' + ID), 'true');

  const reloaded = page({ storage, backend, fetchImpl: async () => res(200, { ok: true, action: 'cancelled' }) });   // a brand-new page
  await reloaded.run('nexarRestorePendingConfirm()'); await new Promise((r) => setTimeout(r, 10));
  const c = reloaded.card();
  assert.equal(c.state, 'uncertain'); assert.deepEqual(c.buttons, ['CHECK AGAIN', 'SEND DELETE AGAIN']);
  await reloaded.run(`nexarConfirmAction('${ID}', false, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(reloaded.fetches.length, 0, 'Keep cannot be sent after Delete, even after a reload');

  const other = page({ storage, userId: 'user-2', backend });          // same browser, another account
  await other.run('nexarRestorePendingConfirm()'); await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(other.card().buttons, ['KEEP JOB', 'DELETE'], 'the stored choice is scoped to the account');
});
test('R5 the stored choice is written before sending and removed once an outcome is recorded', async () => {
  const storage = memoryStorage(); let seenAtSend = null;
  const p = page({ storage, backend: jobsBackend, fetchImpl: async () => { seenAtSend = storage.getItem('nexar.confirm.user-1.' + ID); return res(200, { ok: true, action: 'cancelled' }); } });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  await p.run(`nexarConfirmAction('${ID}', false, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(seenAtSend, 'false'); assert.equal(storage.getItem('nexar.confirm.user-1.' + ID), null);
});
test('R5 when the browser cannot store the choice, a restored request offers no answer buttons', async () => {
  const p = page({ storage: brokenStorage, backend: (q) => q.table === 'nexar_pending_actions' ? { data: OPEN_ROWS, error: null } : jobsBackend(q) });
  await p.run('nexarRestorePendingConfirm()');
  const c = p.card(); assert.equal(c.state, 'info'); assert.deepEqual(c.buttons, []); assert.match(c.meta, /cannot tell whether you already answered/);
  await p.run(`nexarConfirmAction('${ID}', true, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(p.fetches.length, 0);
});

// ---- Pipeline permissions ------------------------------------------------------
const view = (p) => ({ locked: p.$('#nexar-pipeline-locked').style.display, pro: p.$('#nexar-pipeline-pro').style.display, add: p.$('#np-add-btn').style.display,
  ro: p.$('#np-readonly').style.display, roText: p.$('#np-readonly-text').textContent, upgrade: p.$('#np-readonly-upgrade').style.display,
  edit: p.dom.window.document.querySelectorAll('.np-icon-btn:not(.danger)').length, del: p.dom.window.document.querySelectorAll('.np-icon-btn.danger').length });
test('Pro: add and edit available', async () => {
  const p = page({ tier: 'pro', backend: jobsBackend }); await p.run('nexarPipelineRefresh()');
  assert.deepEqual(view(p), { locked: 'none', pro: 'flex', add: '', ro: 'none', roText: view(p).roText, upgrade: view(p).upgrade, edit: 1, del: 1 });
});
test('Free or lapsed member with jobs: read-only list, delete kept, no add or edit', async () => {
  const p = page({ tier: 'basic', backend: jobsBackend }); await p.run('nexarPipelineRefresh()');
  const v = view(p);
  assert.deepEqual([v.locked, v.pro, v.add, v.ro, v.upgrade, v.edit, v.del], ['none', 'flex', 'none', 'flex', '', 0, 1]);
  assert.match(v.roText, /read-only/); assert.match(v.roText, /view and delete/); assert.match(v.roText, /NEXAR Pro/);
  p.run('nexarPipelineAddOpen()'); p.run(`nexarPipelineEditOpen('j1')`);
  assert.equal(p.$('#np-form').style.display, 'none'); assert.equal(p.toasts.length, 2);
  await p.run(`nexarPipelineSetStatus('j1', 'Interview')`);
  assert.equal(p.log.filter(q => q.op === 'update' || q.op === 'insert').length, 0, 'no write is even attempted');
});
test('Free member with no jobs: the existing locked panel', async () => {
  const p = page({ tier: 'basic' }); await p.run('nexarPipelineRefresh()');
  assert.deepEqual([view(p).locked, view(p).pro], ['flex', 'none']);
});
test('membership unknown: read-only, no upgrade prompt, list still shown', async () => {
  const p = page({ tier: null, backend: jobsBackend }); await p.run('nexarPipelineRefresh()');
  const v = view(p); assert.deepEqual([v.pro, v.add, v.ro, v.upgrade, v.del], ['flex', 'none', 'flex', 'none', 1]); assert.match(v.roText, /can't confirm your membership/);
});
test('a load failure is not shown as an empty pipeline or the locked panel', async () => {
  const p = page({ tier: 'basic', backend: () => ({ data: null, error: { message: 'down' } }) }); await p.run('nexarPipelineRefresh()');
  assert.equal(view(p).locked, 'none'); assert.equal(p.$('.np-empty-title').textContent, 'Could not load your pipeline');
});
test('an edit that changes no row is reported as not saved; a refused add explains why', async () => {
  const p = page({ tier: 'pro', backend: (q) => q.op === 'update' ? { data: [], error: null } : q.op === 'insert' ? { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } } : jobsBackend(q) });
  await p.run('nexarPipelineRefresh()');
  p.run(`nexarPipelineEditOpen('j1')`); await p.run('nexarPipelineSave()');
  assert.equal(p.toasts.includes('Updated'), false); assert.match(p.toasts.at(-1), /^Save failed: not saved/);
  p.run('nexarPipelineAddOpen()'); p.run(`document.getElementById('np-form-title').value='T'; document.getElementById('np-form-company').value='C';`);
  await p.run('nexarPipelineSave()');
  assert.equal(p.toasts.includes('Added'), false); assert.match(p.toasts.at(-1), /needs NEXAR Pro/);
  await p.run(`nexarPipelineSetStatus('j1', 'Interview')`); assert.match(p.toasts.at(-1), /^Update failed: not saved/);
});
