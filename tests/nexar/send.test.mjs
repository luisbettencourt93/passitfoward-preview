// Front-end tests for the send path: account guard, control ownership, and
// outcomes that stay "not known" after an interrupted message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { page, jobsBackend, memoryStorage, res, REQ } from './harness.mjs';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const enc = new TextEncoder();
// A response whose stream the test feeds by hand.
function stream() {
  const q = []; let waiting = null; const s = { cancelled: false };
  const give = (item) => { if (waiting) { const w = waiting; waiting = null; item.err ? w.reject(item.err) : w.resolve(item); } else q.push(item); };
  s.push = (text) => give({ done: false, value: enc.encode(text) });
  s.end = () => give({ done: true, value: undefined });
  s.fail = (err) => give({ err });
  s.resp = { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, json: async () => ({}),
    body: { getReader: () => ({ read: () => { if (q.length) { const i = q.shift(); return i.err ? Promise.reject(i.err) : Promise.resolve(i); } const d = deferred(); waiting = d; return d.promise; },
      cancel: async () => { s.cancelled = true; if (waiting) { const w = waiting; waiting = null; w.resolve({ done: true, value: undefined }); } } }) } };
  return s;
}
const CONFIRM = { action_id: '11111111-1111-4111-8111-111111111111', preview: 'Delete "Design system clean-up" @ Tidewater Studio (Applied)?', expires_at: new Date(Date.now() + 600000).toISOString(), action_type: 'delete_pipeline' };
const FULL = ev('meta', { tier: 'pro', remaining_today: 3 }) + ev('delta', { text: 'Private reply for member one.' }) +
  ev('tool_call', { name: 'update_user_skills', input: {} }) + ev('tool_result', { name: 'update_user_skills', ok: true, skills: ['a', 'b', 'c'] }) +
  ev('confirm_required', CONFIRM) + ev('done', { tokens: {} });
const CLEAR = ` document.getElementById('nexar-stream').textContent = '';`;
const SWITCHES = {
  'another member signs in': `currentUser = { id: 'user-2', skills: ['kept'] }; nexarState.authVersion++; nexarState.authUserId = 'user-2';` + CLEAR,
  'sign-out': `nexarState.authVersion++; nexarState.authSignedOut = true; nexarState.authUserId = null;` + CLEAR,
  'away and back to the same account': `{ const me = currentUser; currentUser = { id: 'user-2' }; nexarState.authVersion++; nexarState.authUserId = 'user-2';
     currentUser = me; nexarState.authVersion++; nexarState.authUserId = 'user-1'; nexarState.authSignedOut = false; }` + CLEAR,
};
const type = (p, text) => p.run(`document.getElementById('nexar-input').value = ${JSON.stringify(text)}; nexarSend()`);
const shown = (p) => ({ assistant: p.dom.window.document.querySelectorAll('.nexar-msg.assistant:not(.nexar-interrupted-note)').length,
  cards: p.dom.window.document.querySelectorAll('.nexar-confirm-card').length, notes: p.dom.window.document.querySelectorAll('.nexar-interrupted-note').length,
  text: p.$('#nexar-stream').textContent });
const draftBackend = (q) => q.table === 'nexar_matches' ? { data: { id: 'm1', draft_text: 'Draft for member one', opportunities: { poster_handle: '@lanternworks' } }, error: null } : jobsBackend(q);

test('normal send on one account: reply, tool effects, confirmation and draft all appear, controls are released', async () => {
  const s = stream(); const p = page({ backend: draftBackend, fetchImpl: async () => s.resp });
  const done = type(p, 'Delete the Tidewater job'); s.push(FULL); s.end(); await done;
  const v = shown(p);
  assert.match(v.text, /Private reply for member one\./); assert.equal(v.cards, 1); assert.equal(v.notes, 0);
  assert.deepEqual(p.card().buttons, ['KEEP JOB', 'DELETE']);
  assert.deepEqual(p.run('currentUser.skills'), ['a', 'b', 'c']); assert.ok(p.toasts.includes('Saved 3 skills'));
  assert.equal(p.run('nexarState.remainingToday'), 3);
  assert.deepEqual(p.drafts, [{ text: 'Draft for member one', handle: '@lanternworks', id: 'm1' }]);
  assert.equal(p.run('nexarState.sending'), false); assert.equal(p.$('#nexar-send-btn').disabled, false);
  assert.equal(p.storage.getItem('nexar.interrupted.user-1'), null);
  assert.equal(p.fetches[0].body.message, 'Delete the Tidewater job');
});
test('a second send on the same account is still blocked while the first is running', async () => {
  const s = stream(); const p = page({ backend: jobsBackend, fetchImpl: async () => s.resp });
  const first = type(p, 'one'); await tick(); await type(p, 'two');
  assert.equal(p.fetches.length, 1);
  s.push(ev('delta', { text: 'ok' }) + ev('done', {})); s.end(); await first;
  assert.equal(p.run('nexarState.sending'), false);
});

for (const [name, change] of Object.entries(SWITCHES)) {
  test(`S1 late response after ${name}: no reply, confirmation, tool effect or draft from the earlier send`, async () => {
    const gate = deferred(); const s = stream();
    const p = page({ backend: draftBackend, fetchImpl: () => gate.promise });
    p.run(`currentUser.skills = ['original']`);
    const done = type(p, 'Delete the Tidewater job'); await tick();
    p.run(change);
    gate.resolve(s.resp); s.push(FULL); s.end(); await done; await tick(450);        // also past the delayed draft callback
    const v = shown(p);
    assert.deepEqual([v.assistant, v.cards], [0, 0]); assert.equal(/Private reply|Tidewater/.test(v.text), false);
    assert.deepEqual(p.toasts, []); assert.deepEqual(p.drafts, []); assert.equal(p.run('nexarState.remainingToday'), null);
    assert.notDeepEqual(p.run('currentUser.skills'), ['a', 'b', 'c']);
    assert.equal(p.log.filter(q => q.table === 'nexar_matches' || q.table === 'nexar_pipeline').length, 0, 'no reads made for the earlier send');
    assert.equal(s.cancelled || p.fetches[0].signal.aborted, true, 'the old stream is stopped');
    assert.ok(p.storage.getItem('nexar.interrupted.user-1'), 'the outcome is kept as not known for the member who sent it');
  });
  test(`S2 ${name} during the session lookup or context build: the message is never sent`, async () => {
    for (const where of ['session', 'context']) {
      const gate = deferred();
      const p = page({ fetchImpl: async () => { throw new Error('must not be called'); },
        ...(where === 'session' ? { getSession: () => gate.promise } : { buildContext: () => gate.promise }) });
      const done = type(p, 'Mark the Lanternworks job as Interview'); await tick();
      p.run(change);
      gate.resolve(where === 'session' ? { data: { session: { access_token: 'token-of-whoever-is-signed-in-now' } } } : { user: { handle: '@someone-else' } });
      await done;
      assert.equal(p.fetches.length, 0, where); assert.equal(p.storage.getItem('nexar.interrupted.user-1'), null, 'nothing went out, so nothing is uncertain');
      assert.equal(shown(p).assistant, 0);
    }
  });
  test(`S3 ${name} between stream reads: later events are dropped and the stream is stopped`, async () => {
    const s = stream(); const p = page({ backend: draftBackend, fetchImpl: async () => s.resp });
    const done = type(p, 'hello'); s.push(ev('delta', { text: 'First part.' })); await tick();
    assert.match(shown(p).text, /First part\./);
    p.run(change);
    s.push(ev('delta', { text: ' Second part, private.' }) + ev('confirm_required', CONFIRM) + ev('done', {})); s.end(); await done;
    const v = shown(p); assert.deepEqual([v.assistant, v.cards], [0, 0]); assert.equal(/Second part/.test(v.text), false); assert.equal(s.cancelled, true);
    assert.deepEqual(p.drafts, []);
  });
  test(`S4 ${name} while a tool-result effect or a draft read is waiting: nothing is drawn afterwards`, async () => {
    // (a) Pipeline reload after a tool result
    const load = deferred(); const s = stream();
    const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? load.promise : { data: null, error: null }, fetchImpl: async () => s.resp });
    p.run(`_pipelineCanWrite = true;`);
    const done = type(p, 'add it'); s.push(ev('tool_call', { name: 'add_pipeline_entry', input: {} }) + ev('tool_result', { name: 'add_pipeline_entry', ok: true, entry: { title: 'T', company: 'C' } })); await tick();
    p.run(change);
    load.resolve({ data: [{ id: 'j1', title: 'Member one job', company: 'Co', status: 'Applied', updated_at: new Date().toISOString() }], error: null });
    s.push(ev('delta', { text: 'late' }) + ev('done', {})); s.end(); await done;
    assert.equal(p.$('#np-list').children.length, 0, 'the earlier member\'s jobs are not drawn'); assert.equal(shown(p).assistant, 0);
    // (b) the delayed draft callback, and (c) the draft renderer's own read
    const read = deferred(); const s2 = stream();
    const p2 = page({ backend: (q) => q.table === 'nexar_matches' ? read.promise : jobsBackend(q), fetchImpl: async () => s2.resp });
    const done2 = type(p2, 'draft it'); s2.push(ev('tool_result', { name: 'draft_opportunity_response', ok: true })); await tick();
    p2.run(change);
    await tick(450);
    assert.equal(p2.log.filter(q => q.table === 'nexar_matches').length, 0, 'the delayed callback does not even read');
    s2.end(); await done2;
    const p3 = page({ backend: (q) => q.table === 'nexar_matches' ? read.promise : jobsBackend(q) });
    const direct = p3.run('nexarRenderLatestDraftFromDb()'); await tick();
    p3.run(change);
    read.resolve({ data: { id: 'm1', draft_text: 'Draft for member one', opportunities: { poster_handle: '@x' } }, error: null }); await direct;
    assert.deepEqual(p3.drafts, []);
  });
  test(`S5 history read finishing after ${name}: the earlier member's messages are not drawn`, async () => {
    const gate = deferred();
    const p = page({ backend: (q) => q.table === 'nexar_conversations' ? gate.promise : { data: [], error: null } });
    const done = p.run('nexarLoadHistory()'); await tick();
    p.run(change);
    gate.resolve({ data: [{ role: 'assistant', content: 'Private history line', created_at: 'x' }], error: null }); await done;
    assert.equal(/Private history/.test(shown(p).text), false);
  });
}
test('S5 history on an unchanged account still loads', async () => {
  const p = page({ backend: (q) => q.table === 'nexar_conversations' ? { data: [{ role: 'assistant', content: 'My history line', created_at: 'x' }], error: null } : { data: [], error: null } });
  await p.run('nexarLoadHistory()'); assert.match(shown(p).text, /My history line/);
});

test('S6 an older send finishing cannot reset a newer send\'s controls, and does not block it', async () => {
  const gateA = deferred(); const sB = stream(); let n = 0;
  const p = page({ backend: jobsBackend, fetchImpl: () => (++n === 1 ? gateA.promise : Promise.resolve(sB.resp)) });
  const a = type(p, 'from member one'); await tick();
  p.run(SWITCHES['another member signs in']);
  const b = type(p, 'from member two'); await tick();
  assert.equal(p.fetches.length, 2, 'the new member is not blocked by the earlier send');
  assert.equal(p.fetches[0].signal.aborted, true, 'the earlier request is aborted');
  const sA = stream(); gateA.resolve(sA.resp); sA.push(ev('delta', { text: 'old reply' }) + ev('done', {})); sA.end(); await a; await tick();
  assert.equal(p.run('nexarState.sending'), true, 'still sending for the new member'); assert.equal(p.$('#nexar-send-btn').disabled, true);
  assert.ok(p.$('#nexar-typing-node'), 'the new member\'s progress indicator is untouched'); assert.equal(/old reply/.test(shown(p).text), false);
  sB.push(ev('delta', { text: 'reply for member two' }) + ev('done', {})); sB.end(); await b;
  assert.match(shown(p).text, /reply for member two/); assert.equal(p.run('nexarState.sending'), false); assert.equal(p.$('#nexar-send-btn').disabled, false);
  assert.ok(p.storage.getItem('nexar.interrupted.user-1')); assert.equal(p.storage.getItem('nexar.interrupted.user-2'), null);
});
test('S6 an aborted fetch (rejects) from the earlier send is equally silent', async () => {
  const gateA = deferred(); const sB = stream(); let n = 0;
  const p = page({ backend: jobsBackend, fetchImpl: () => (++n === 1 ? gateA.promise : Promise.resolve(sB.resp)) });
  const a = type(p, 'one'); await tick(); p.run(SWITCHES['sign-out']);
  p.run(`nexarState.authSignedOut = false; currentUser = { id: 'user-2' }; nexarState.authUserId = 'user-2';`);
  const b = type(p, 'two'); await tick();
  gateA.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); await a;
  assert.equal(p.run('nexarState.sending'), true); assert.equal(/CONNECTION/.test(shown(p).text), false);
  sB.push(ev('delta', { text: 'ok' }) + ev('done', {})); sB.end(); await b; assert.equal(p.run('nexarState.sending'), false);
});

test('S7 a stream cut short after an action started: outcome stays "not known", no "try again", and it survives a reload', async () => {
  for (const how of ['read fails', 'closes without the closing event']) {
    const storage = memoryStorage(); const s = stream();
    const p = page({ storage, backend: jobsBackend, fetchImpl: async () => s.resp });
    const done = type(p, 'Add Marlow Health'); s.push(ev('delta', { text: 'Adding' }) + ev('tool_call', { name: 'add_pipeline_entry', input: {} }));
    how === 'read fails' ? s.fail(new Error('network')) : s.end(); await done;
    const v = shown(p);
    assert.equal(v.notes, 1, how); assert.match(v.text, /NEXAR may still have acted on it \(it had started adding a job\)/); assert.match(v.text, /do not know whether that completed/);
    assert.equal(/try again/i.test(v.text), false); assert.equal(/unchanged|did not|was not added/i.test(v.text), false);
    assert.equal(p.run('nexarState.sending'), false);

    const reloaded = page({ storage, backend: (q) => ({ data: [], error: null }) });      // same member, new page
    await reloaded.run('nexarLoadHistory()');
    assert.equal(shown(reloaded).notes, 1, 'still shown after a reload');
    const other = page({ storage, userId: 'user-2', backend: () => ({ data: [], error: null }) });
    await other.run('nexarLoadHistory()'); assert.equal(shown(other).notes, 0, 'never shown to another member');
    reloaded.$('.nexar-interrupted-note button').click();
    assert.equal(shown(reloaded).notes, 0); assert.equal(storage.getItem('nexar.interrupted.user-1'), null, 'cleared only when the member says they checked');
  }
});
test('S7 a send abandoned by an account switch is shown to that member when they return, not to anyone else', async () => {
  const storage = memoryStorage(); const s = stream();
  const p = page({ storage, backend: jobsBackend, fetchImpl: async () => s.resp });
  const done = type(p, 'Mark Lanternworks as Interview'); s.push(ev('tool_call', { name: 'update_pipeline_status', input: {} })); await tick();
  p.run(SWITCHES['another member signs in']); s.push(ev('delta', { text: 'x' })); await done;
  assert.equal(shown(p).notes, 0, 'not shown to the member who is signed in now');
  const back = page({ storage, backend: () => ({ data: [], error: null }) });
  await back.run('nexarLoadHistory()');
  assert.equal(shown(back).notes, 1); assert.match(shown(back).text, /it had started a status change/);
});
test('S7 failures where nothing ran keep their plain wording and record nothing', async () => {
  const noToken = page({ getSession: async () => ({ data: { session: null } }), fetchImpl: async () => { throw new Error('no'); } });
  await type(noToken, 'hi');
  assert.match(shown(noToken).text, /CONNECTION ERROR — no_session\. Try again\./); assert.equal(noToken.fetches.length, 0); assert.equal(noToken.storage.getItem('nexar.interrupted.user-1'), null);
  const limited = page({ tier: 'basic', fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => 'application/json' }, json: async () => ({ error: 'rate_limit' }) }) });
  await type(limited, 'hi');
  assert.equal(limited.modals.length, 1); assert.equal(limited.storage.getItem('nexar.interrupted.user-1'), null); assert.equal(limited.run('nexarState.sending'), false);
  const refused = page({ fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => 'application/json' }, json: async () => ({ error: 'status_check_failed' }) }) });
  await type(refused, 'hi');
  assert.match(shown(refused).text, /SYSTEM ERROR — status_check_failed/); assert.equal(refused.storage.getItem('nexar.interrupted.user-1'), null);
});

// ---- The shared jobs cache -------------------------------------------------------
const OLD = new Date(Date.now() - 20 * 86400000).toISOString();
const ONE_JOB = [{ id: 'j1', title: 'Member one job', company: 'Co', status: 'Applied', updated_at: OLD }];
for (const [name, change] of Object.entries(SWITCHES)) {
  test(`S8 a jobs read finishing after ${name} does not fill the shared cache`, async () => {
    const gate = deferred();
    const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? gate.promise : { data: [], error: null } });
    const done = p.run('nexarPipelineLoad()'); await tick();
    p.run(change);
    gate.resolve({ data: ONE_JOB, error: null }); await done;
    assert.equal(p.run('__get().cache.length'), 0);
  });
}
test('S8 follow-up reminders never use jobs cached for a different member', async () => {
  let rows = ONE_JOB;
  const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? { data: rows, error: null } : { data: [], error: null } });
  await p.run('nexarPipelineLoad()');
  assert.equal((await p.run('nexarComputePipelineReminders()')).count, 1, 'the owner still gets their follow-up');
  rows = [];
  p.run(`currentUser = { id: 'user-2' }; nexarState.authVersion++; nexarState.authUserId = 'user-2';`);
  p.authEvent('SIGNED_IN', { user: { id: 'user-2' } });         // a real switch also reaches the auth callback
  const r = await p.run('nexarComputePipelineReminders()');
  assert.deepEqual([r.count, r.items.length], [0, 0]);
  assert.equal(p.log.at(-1).filters.user_id, 'user-2', 'it reloads for the member who is signed in');
});

// ---- Regression: review round 4 -------------------------------------------------
const A_JOBS = [{ id: 'a1', title: 'Member one job', company: 'Co', status: 'Applied', updated_at: OLD }];
const B_JOBS = [{ id: 'b1', title: 'Member two job', company: 'Co', status: 'Applied', updated_at: OLD }];
const listText = (p) => p.$('#np-list').textContent;
const OTHER = SWITCHES['another member signs in'];

for (const [name, change] of Object.entries(SWITCHES)) {
  test(`P1 Pipeline refresh in flight during ${name}: the earlier member's cached jobs are not redrawn`, async () => {
    let gate = null;
    const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? (gate ? gate.promise : { data: A_JOBS, error: null }) : { data: [], error: null } });
    await p.run('nexarPipelineRefresh()');
    assert.match(listText(p), /Member one job/, 'the cache and the view are populated for member one');
    gate = deferred();
    const second = p.run('nexarPipelineRefresh()'); await tick();
    p.run(change);
    gate.resolve({ data: A_JOBS, error: null }); await second;
    if (name === 'away and back to the same account') {
      assert.equal(p.run('__get().owner'), 'user-1'); assert.match(listText(p), /Member one job/, 'their own jobs may stay');
    } else {
      assert.equal(listText(p), '', 'nothing of member one is left on screen'); assert.equal(p.run('__get().cache.length'), 0); assert.equal(p.run('__get().owner'), null);
      assert.equal(p.run('__get().canWrite'), false);
    }
  });
}
test('P1 any redraw after an account change clears the earlier member\'s jobs instead of drawing them', async () => {
  const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? { data: A_JOBS, error: null } : { data: [], error: null } });
  await p.run('nexarPipelineRefresh()'); assert.match(listText(p), /Member one job/);
  p.run(`currentUser = { id: 'user-2' }; nexarState.authVersion++; nexarState.authUserId = 'user-2';`);
  p.run('nexarPipelineRender()');
  assert.equal(listText(p), ''); assert.equal(p.run('__get().cache.length'), 0); assert.equal(p.$('#np-empty').style.display, 'none', 'and it does not claim the new member has no jobs');
});
test('P1 a sign-in change clears the cache and the job view at once; a token refresh for the same member does not', async () => {
  const fresh = async () => { const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? { data: A_JOBS, error: null } : { data: [], error: null } }); await p.run('nexarPipelineRefresh()'); return p; };
  let p = await fresh(); p.authEvent('TOKEN_REFRESHED', { user: { id: 'user-1' } });
  assert.match(listText(p), /Member one job/); assert.equal(p.run('__get().cache.length'), 1);
  p = await fresh(); p.authEvent('SIGNED_OUT', null);
  assert.equal(listText(p), ''); assert.equal(p.run('__get().cache.length'), 0);
  p = await fresh(); p.authEvent('SIGNED_IN', { user: { id: 'user-2' } });
  assert.equal(listText(p), ''); assert.equal(p.run('__get().owner'), null);
});
test('P2 an old read that fails late cannot erase the new member\'s jobs', async () => {
  for (const failure of ['rejects', 'returns an error']) {
    const gateA = deferred(); let n = 0;
    const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? (++n === 1 ? gateA.promise : { data: B_JOBS, error: null }) : { data: [], error: null } });
    const a = p.run('nexarPipelineLoad()'); await tick();
    p.run(OTHER); p.authEvent('SIGNED_IN', { user: { id: 'user-2' } });   // a real switch also reaches the auth callback
    await p.run('nexarPipelineLoad()');
    assert.equal(p.run('__get().cache[0].id'), 'b1');
    failure === 'rejects' ? gateA.reject(new Error('network')) : gateA.resolve({ data: null, error: { message: 'boom' } });
    await a;
    assert.equal(p.run('__get().cache.length'), 1, failure); assert.equal(p.run('__get().cache[0].id'), 'b1'); assert.equal(p.run('__get().owner'), 'user-2'); assert.equal(p.run('__get().failed'), false);
  }
});
test('P2 on one account, an older read finishing late (failed or not) cannot replace a newer result', async () => {
  for (const late of ['rejects', 'old data']) {
    const g1 = deferred(); let n = 0;
    const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? (++n === 1 ? g1.promise : { data: B_JOBS, error: null }) : { data: [], error: null } });
    const first = p.run('nexarPipelineLoad()'); await tick(); await p.run('nexarPipelineLoad()');
    late === 'rejects' ? g1.reject(new Error('network')) : g1.resolve({ data: A_JOBS, error: null }); await first;
    assert.equal(p.run('__get().cache[0].id'), 'b1', late); assert.equal(p.run('__get().failed'), false);
  }
});
test('P2 a failed read for the signed-in member is still reported as a failure, not as an empty Pipeline', async () => {
  const p = page({ tier: 'pro', backend: (q) => q.table === 'nexar_pipeline' ? Promise.reject(new Error('down')) : { data: [], error: null } });
  await p.run('nexarPipelineRefresh()');
  assert.equal(p.run('__get().failed'), true); assert.equal(p.$('.np-empty-title').textContent, 'Could not load your pipeline');
});

test('P3 a session that belongs to someone else: the message is not sent under their name', async () => {
  for (const other of ['user-2', null]) {
    const p = page({ fetchImpl: async () => { throw new Error('must not be called'); } });
    p.session.userId = other;                                   // the page still shows user-1
    await type(p, 'Mark Lanternworks as Interview');
    assert.equal(p.fetches.length, 0, String(other));
    assert.match(shown(p).text, /NOT SENT\. Your sign-in changed or could not be confirmed/);
    assert.equal(p.$('#nexar-input').value, 'Mark Lanternworks as Interview', 'the text is given back');
    assert.equal(p.storage.getItem('nexar.interrupted.user-1'), null, 'nothing went out'); assert.equal(shown(p).notes, 0);
    assert.equal(p.run('nexarState.sending'), false); assert.equal(p.$('#nexar-send-btn').disabled, false);
  }
});
test('P3 a matching session sends with that member\'s token', async () => {
  const s = stream(); const p = page({ backend: jobsBackend, fetchImpl: async () => s.resp });
  const done = type(p, 'hello'); s.push(ev('delta', { text: 'hi' }) + ev('done', {})); s.end(); await done;
  assert.equal(p.fetches.length, 1); assert.equal(p.fetches[0].auth, 'Bearer token-for-user-1');
});
test('P3 delete answer: a session for someone else sends nothing and leaves the request as it was', async () => {
  const p = page({ backend: jobsBackend, fetchImpl: async () => res(200, { ok: true, action: 'deleted' }) });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  p.session.userId = 'user-2';
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', true, document.querySelector('.nexar-confirm-card'))`);
  let c = p.card();
  assert.equal(p.fetches.length, 0); assert.equal(c.state, 'open'); assert.deepEqual(c.buttons, ['KEEP JOB', 'DELETE']);
  assert.match(c.body, /^Delete "/); assert.match(c.meta, /Your answer was not sent/);
  assert.equal(c.el.dataset.sentAccept, undefined); assert.equal(p.storage.getItem('nexar.confirm.user-1.11111111-1111-4111-8111-111111111111'), null, 'no choice was recorded');
  p.session.userId = undefined;                                 // sign-in is right again: either answer can be given
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', false, document.querySelector('.nexar-confirm-card'))`);
  assert.equal(p.fetches.length, 1); assert.equal(p.fetches[0].auth, 'Bearer token-for-user-1');
});
test('P3 checking a request under someone else\'s session never closes the card or drops the saved answer', async () => {
  const p = page({ backend: (q) => q.op === 'rpc' ? { data: { found: false }, error: null } : jobsBackend(q), fetchImpl: async () => { throw new Error('network'); } });
  p.run(`nexarRenderConfirmCard(${REQ})`);
  await p.run(`nexarConfirmAction('11111111-1111-4111-8111-111111111111', true, document.querySelector('.nexar-confirm-card'))`);
  const c = p.card();
  assert.equal(c.state, 'uncertain'); assert.equal(c.body, 'Could not check this request.'); assert.deepEqual(c.buttons, ['CHECK AGAIN']);
  assert.equal(p.storage.getItem('nexar.confirm.user-1.11111111-1111-4111-8111-111111111111'), 'true');
});

const plain = (status, body, type = 'application/json') => ({ ok: status >= 200 && status < 300, status, headers: { get: () => type },
  json: async () => { if (body === undefined) throw new Error('not json'); return body; } });
test('P4 an unclear answer after the message went out: outcome stays "not known" and no retry is suggested', async () => {
  const cases = { '504 gateway timeout (JSON)': plain(504, { code: 504, message: 'Gateway Timeout' }), '504 gateway timeout (HTML)': plain(504, undefined, 'text/html'),
    '502 bad gateway': plain(502, undefined, 'text/html'), '500 with an unknown body': plain(500, { message: 'worker crashed' }), '500 with an unknown error code': plain(500, { error: 'boot_error' }),
    '546 resource limit': plain(546, { code: 'WORKER_LIMIT' }), '200 that is not a stream': plain(200, { ok: true }) };
  for (const [name, resp] of Object.entries(cases)) {
    const storage = memoryStorage(); const p = page({ storage, fetchImpl: async () => resp });
    await type(p, 'Add Marlow Health as Applied');
    const v = shown(p);
    assert.equal(v.notes, 1, name); assert.ok(storage.getItem('nexar.interrupted.user-1'), name);
    assert.equal(/try again/i.test(v.text), false, name + ': no retry advice'); assert.match(v.text, /do not know whether that completed/);
    assert.equal(p.run('nexarState.sending'), false); assert.equal(p.$('#nexar-input').value, '', 'the text is not handed back for resending');
  }
});
test('P4 the chat function\'s own refusals are still plain errors with nothing recorded', async () => {
  for (const [status, code] of [[401, 'invalid_session'], [400, 'message_too_long'], [500, 'rate_check_failed'], [500, 'internal_error']]) {
    const p = page({ fetchImpl: async () => plain(status, { error: code }) });
    await type(p, 'hi');
    assert.match(shown(p).text, new RegExp('SYSTEM ERROR — ' + code + '\\. Try again\\.')); assert.equal(shown(p).notes, 0); assert.equal(p.storage.getItem('nexar.interrupted.user-1'), null);
  }
});

// ---- Regression: review round 5 -------------------------------------------------
// Everything here goes through the auth callback only. The displayed profile
// (currentUser) and NEXAR's markers (nexarState) are left exactly as they were
// until the pending read has finished, as when NEXAR has not been opened yet.
const STATE0 = JSON.stringify({ tier: 'pro', authVersion: 1, loadRequest: 1, authSignedOut: false, authUserId: 'user-1', sending: false, remainingToday: null });
const untouched = (p) => { assert.equal(p.run('currentUser.id'), 'user-1'); assert.equal(p.run('JSON.stringify(nexarState)'), STATE0); };
const pipelineReads = (p) => p.log.filter((q) => q.table === 'nexar_pipeline').length;

test('Q1 Command Centre read pending at sign-out: the earlier member\'s job does not come back into the cache or the follow-up list', async () => {
  for (const cachedFirst of [false, true]) {
    let gate = null;
    const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? (gate ? gate.promise : { data: A_JOBS, error: null }) : { data: [], error: null } });
    if (cachedFirst) { await p.run('nexarPipelineRefresh()'); assert.match(listText(p), /Member one job/); p.run('_pipelineCache = _pipelineCache.slice()'); }
    gate = deferred();
    const pending = cachedFirst ? p.run('nexarPipelineLoad().then(() => nexarComputePipelineReminders())') : p.run('nexarComputePipelineReminders()');
    await tick();
    assert.equal(pipelineReads(p), cachedFirst ? 2 : 1, 'a read is in flight');
    p.authEvent('SIGNED_OUT', null);                             // the callback only
    untouched(p);
    assert.equal(p.run('__get().cache.length'), 0); assert.equal(listText(p), '', 'cache and view are cleared at once');
    gate.resolve({ data: A_JOBS, error: null });
    const r = await pending;
    untouched(p);
    assert.equal(p.run('__get().cache.length'), 0, 'the pending read did not refill the cache'); assert.equal(p.run('__get().owner'), null);
    assert.deepEqual([r.count, r.items.length], [0, 0], 'and nothing reaches the follow-up list'); assert.equal(listText(p), '');
  }
});
test('Q2 another member signs in during an initially empty load: the earlier member\'s jobs are not cached for them', async () => {
  const gate = deferred();
  const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? gate.promise : { data: [], error: null } });
  const pending = p.run('nexarComputePipelineReminders()'); await tick();
  assert.equal(p.run('__get().owner'), null, 'nothing was cached before');
  p.authEvent('SIGNED_IN', { user: { id: 'user-2' } });          // the callback only
  untouched(p);
  gate.resolve({ data: A_JOBS, error: null });
  const r = await pending;
  untouched(p);
  assert.equal(p.run('__get().cache.length'), 0); assert.deepEqual([r.count, r.items.length], [0, 0]);
  assert.equal(p.run('__get().sessionUser'), 'user-2');
  // and while the page still displays the earlier member, nothing is read or drawn in their name
  const before = pipelineReads(p);
  await p.run('nexarPipelineRefresh()');
  assert.equal(pipelineReads(p), before, 'no read is made as the displayed member'); assert.equal(listText(p), '');
  assert.equal(p.$('.np-empty-title').textContent, 'Could not confirm your sign-in', 'and the screen does not claim there are no jobs');
});
test('Q3 a failed pending read after the callback reported a change cannot mark or clear anything', async () => {
  const gate = deferred();
  const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? gate.promise : { data: [], error: null } });
  const pending = p.run('nexarPipelineLoad()'); await tick();
  p.authEvent('SIGNED_OUT', null); gate.reject(new Error('network'));
  assert.equal(await pending, false); assert.equal(p.run('__get().failed'), false); assert.equal(p.run('__get().owner'), null);
});
test('Q4 same-member callbacks keep a pending read and the cache: token refresh, repeated sign-in, initial session', async () => {
  for (const event of ['TOKEN_REFRESHED', 'SIGNED_IN', 'INITIAL_SESSION', 'USER_UPDATED']) {
    const gate = deferred();
    const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? gate.promise : { data: [], error: null } });
    const pending = p.run('nexarComputePipelineReminders()'); await tick();
    p.authEvent(event, { user: { id: 'user-1' } });
    gate.resolve({ data: A_JOBS, error: null });
    const r = await pending;
    assert.equal(r.count, 1, event); assert.equal(p.run('__get().cache.length'), 1); assert.equal(p.run('__get().epoch'), 0, 'nothing was invalidated');
    p.authEvent(event, { user: { id: 'user-1' } });
    assert.equal(p.run('__get().cache.length'), 1, 'and a later same-member callback keeps the cache');
  }
});
test('Q5 away and back to the same member through the callback: the old read is dropped, a new one works', async () => {
  const gate = deferred(); let n = 0;
  const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? (++n === 1 ? gate.promise : { data: B_JOBS, error: null }) : { data: [], error: null } });
  const old = p.run('nexarPipelineLoad()'); await tick();
  p.authEvent('SIGNED_OUT', null); p.authEvent('SIGNED_IN', { user: { id: 'user-1' } });
  gate.resolve({ data: A_JOBS, error: null });
  assert.equal(await old, false); assert.equal(p.run('__get().cache.length'), 0);
  assert.equal(await p.run('nexarPipelineLoad()'), true); assert.equal(p.run('__get().cache[0].id'), 'b1'); assert.equal(p.run('__get().owner'), 'user-1');
});
test('Q6 while signed out is the last thing seen, no read is made for the member still displayed; a first session for someone else drops the read', async () => {
  const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? { data: A_JOBS, error: null } : { data: [], error: null } });
  await p.run('nexarPipelineLoad()'); p.authEvent('SIGNED_OUT', null);
  const before = pipelineReads(p);
  assert.equal(await p.run('nexarPipelineLoad()'), false); assert.equal(pipelineReads(p), before); assert.equal(p.run('__get().cache.length'), 0);
  assert.deepEqual((await p.run('nexarComputePipelineReminders()')).count, 0);

  const gate = deferred();
  const q = page({ backend: (x) => x.table === 'nexar_pipeline' ? gate.promise : { data: [], error: null } });
  const pending = q.run('nexarPipelineLoad()'); await tick();
  q.authEvent('INITIAL_SESSION', { user: { id: 'user-2' } });     // the session never was the displayed member's
  gate.resolve({ data: A_JOBS, error: null });
  assert.equal(await pending, false); assert.equal(q.run('__get().cache.length'), 0);
});
test('Q7 a callback from a client that has been replaced is ignored; the new client starts unseen', async () => {
  const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? { data: A_JOBS, error: null } : { data: [], error: null } });
  await p.run('nexarPipelineLoad()');
  const oldListeners = p.run('sb._authListeners').slice();
  p.run(`{ const l = []; sb = { ...sb, _authListeners: l, auth: { ...sb.auth, onAuthStateChange: (cb) => { l.push(cb); return { data: { subscription: { unsubscribe() {} } } }; } } }; }`);
  assert.equal(await p.run('nexarPipelineLoad()'), true); assert.equal(p.run('__get().cache.length'), 1);
  oldListeners.forEach((cb) => cb('SIGNED_OUT', null));
  assert.equal(p.run('__get().cache.length'), 1, 'the old client cannot clear the new client\'s jobs');
  p.authEvent('SIGNED_OUT', null);
  assert.equal(p.run('__get().cache.length'), 0, 'the current client still can');
});
test('Q8 the page shows a different member than the session was last seen as: nothing is read, and the screen says why', async () => {
  const p = page({ backend: (q) => q.table === 'nexar_pipeline' ? { data: A_JOBS, error: null } : { data: [], error: null } });
  await p.run('nexarPipelineRefresh()');
  p.run(`currentUser = { id: 'user-2' }; nexarState.authVersion++; nexarState.authUserId = 'user-2';`);   // profile changed, no callback seen
  const before = pipelineReads(p);
  await p.run('nexarPipelineRefresh()');
  assert.equal(pipelineReads(p), before); assert.equal(listText(p), ''); assert.equal(p.run('__get().cache.length'), 0);
  assert.equal(p.$('.np-empty-title').textContent, 'Could not confirm your sign-in'); assert.equal(p.$('#np-empty').style.display, 'flex');
  p.authEvent('SIGNED_IN', { user: { id: 'user-2' } });         // once the callback agrees, the new member loads normally
  await p.run('nexarPipelineRefresh()');
  assert.equal(pipelineReads(p), before + 1); assert.equal(p.run('__get().owner'), 'user-2');
});
