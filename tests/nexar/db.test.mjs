// Database tests. They run against a THROWAWAY LOCAL Postgres only.
// NEXAR_TEST_PG must point at a local server, for example
//   NEXAR_TEST_PG=postgres://postgres@127.0.0.1:54329/postgres node --test db.test.mjs
// The suite refuses any host that is not 127.0.0.1 / localhost.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const base = new URL(process.env.NEXAR_TEST_PG || 'postgres://postgres@127.0.0.1:54329/postgres');
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Refusing to run: NEXAR_TEST_PG is not a local server.');
const DB = 'nexar_patch_test';
const MIG = ['20261110230000_nexar_pipeline_pro_write_enforcement', '20261110230100_nexar_restrict_elevated_functions', '20261110230200_nexar_pending_action_resolution'];
const sql = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const U = { pro: '00000000-0000-4000-8000-000000000001', free: '00000000-0000-4000-8000-000000000002', lapsed: '00000000-0000-4000-8000-000000000003',
            trial: '00000000-0000-4000-8000-000000000004', cancelled: '00000000-0000-4000-8000-000000000005', pro2: '00000000-0000-4000-8000-000000000006' };
let admin, pool;

// Run fn as a signed-in member (or anon / service_role) inside one transaction.
async function as(who, fn, client) {
  const c = client || await pool.connect();
  try {
    await c.query('begin');
    const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)`, [U[who] || '', role]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { if (!client) c.release(); }
}
const denied = (p) => assert.rejects(p, (e) => e.code === '42501', 'expected a permission error (42501)');
const one = async (c, q, a) => (await c.query(q, a)).rows[0];
async function addJob(who = 'pro', title = 'Product designer') {
  return (await pool.query(`insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h',$2,'Lanternworks') returning id`, [U[who], title])).rows[0].id;
}
const request = (who, job, preview = 'Delete?') => as('service', (c) => one(c, `insert into public.nexar_pending_actions (user_id, action_type, target_id, preview) values ($1,'delete_pipeline',$2,$3) returning id`, [U[who], job, preview])).then(r => r.id);
const settle = (who, id, client) => as(who, (c) => one(c, 'select public.nexar_settle_pending_action($1) as r', [id]), client).then(r => r.r);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const confirm = (who, id, accept) => as('service', (c) => one(c, `select public.nexar_confirm_pending_action($1,$2,$3) as r`, [id, U[who], accept])).then(r => r.r);
const jobExists = async (id) => (await pool.query('select 1 from public.nexar_pipeline where id=$1', [id])).rowCount === 1;
const outcome = async (id) => (await pool.query('select outcome, consumed_at from public.nexar_pending_actions where id=$1', [id])).rows[0];
const applyAll = async (dir, suffix, list) => { for (const m of list) await pool.query(sql(`supabase/${dir}/${m}${suffix}.sql`)); };

before(async () => {
  admin = new pg.Client({ connectionString: base.href }); await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  for (const r of ['anon', 'authenticated', 'service_role']) await admin.query(`drop role if exists ${r}`);
  await admin.query(`create database ${DB}`);
  const u = new URL(base.href); u.pathname = '/' + DB;
  pool = new pg.Pool({ connectionString: u.href, max: 8 });
  pool.on('error', () => {});   // teardown closes idle connections; that is not a test failure
  await pool.query(sql('tests/nexar/fixture.sql'));
  for (const id of Object.values(U)) await pool.query('insert into auth.users values ($1)', [id]);
  for (const [k, id] of Object.entries(U)) await pool.query(`insert into public.profiles values ($1,$2,'["figma"]')`, [id, '@' + k]);
  await pool.query(`insert into public.nexar_subscriptions values
    ($1,'active', now() + interval '20 days'), ($2,'active', now() - interval '1 day'), ($3,'trialing', null), ($4,'canceled', now() + interval '5 days'), ($5,'active', null)`,
    [U.pro, U.lapsed, U.trial, U.cancelled, U.pro2]);
});
after(async () => { await pool?.end(); await new Promise(r => setTimeout(r, 150)); await admin?.query(`drop database if exists ${DB}`).catch(() => {}); await admin?.end(); });

test('BEFORE the migrations: the reported gaps exist in the fixture', async () => {
  await as('free', (c) => c.query('select * from public.generate_pipeline_reminders()'));
  await as('free', (c) => c.query(`insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h','Free job','Co')`, [U.free]));
  assert.equal((await pool.query('select count(*)::int n from public.nexar_pipeline where user_id=$1', [U.free])).rows[0].n, 1);
});

test('the migrations apply, and apply a second time without error', async () => {
  await applyAll('migrations', '', MIG);
  await applyAll('migrations', '', MIG);
});

// ---- Pipeline permissions ---------------------------------------------------
test('Pro: add, edit, change status, read and delete own jobs', async () => {
  await as('pro', async (c) => {
    const { id } = await one(c, `insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h','A','B') returning id`, [U.pro]);
    assert.equal((await c.query(`update public.nexar_pipeline set status='Interview', notes='n' where id=$1 returning id`, [id])).rowCount, 1);
    assert.equal((await c.query('select 1 from public.nexar_pipeline where id=$1', [id])).rowCount, 1);
    assert.equal((await c.query('delete from public.nexar_pipeline where id=$1', [id])).rowCount, 1);
  });
});
test('trialing counts as Pro (existing definition)', async () => {
  await as('trial', (c) => c.query(`insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h','T','B')`, [U.trial]));
});
for (const who of ['free', 'lapsed', 'cancelled']) {
  test(`${who}: cannot add or edit; can still read and delete own jobs`, async () => {
    const id = await addJob(who, 'Kept job');
    await denied(as(who, (c) => c.query(`insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h','X','Y')`, [U[who]])));
    await as(who, async (c) => {
      assert.equal((await c.query(`update public.nexar_pipeline set status='Offered' where id=$1 returning id`, [id])).rowCount, 0, 'edit must change no row');
      assert.equal((await c.query('select status from public.nexar_pipeline where id=$1', [id])).rows[0].status, 'Applied');
      assert.equal((await c.query('delete from public.nexar_pipeline where id=$1', [id])).rowCount, 1);
    });
  });
}
test('Pro cannot add for, edit, read or delete another member\'s jobs', async () => {
  const other = await addJob('pro2', 'Other member');
  await denied(as('pro', (c) => c.query(`insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h','X','Y')`, [U.pro2])));
  await as('pro', async (c) => {
    assert.equal((await c.query('select 1 from public.nexar_pipeline where id=$1', [other])).rowCount, 0);
    assert.equal((await c.query(`update public.nexar_pipeline set title='x' where id=$1`, [other])).rowCount, 0);
    assert.equal((await c.query('delete from public.nexar_pipeline where id=$1', [other])).rowCount, 0);
  });
  await denied(as('pro', async (c) => { const { id } = await one(c, `insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h','Mine','Y') returning id`, [U.pro]);
    await c.query('update public.nexar_pipeline set user_id=$2 where id=$1', [id, U.pro2]); }));
  assert.ok(await jobExists(other));
});
test('signed-out visitors can do nothing with jobs', async () => {
  await as('anon', async (c) => assert.equal((await c.query('select 1 from public.nexar_pipeline')).rowCount, 0));
  await denied(as('anon', (c) => c.query(`insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h','X','Y')`, [U.pro])));
});

// ---- Elevated functions -----------------------------------------------------
test('members and visitors cannot call the elevated functions; the server can', async () => {
  for (const who of ['pro', 'free', 'anon']) {
    await denied(as(who, (c) => c.query('select * from public.generate_pipeline_reminders()')));
    await denied(as(who, (c) => c.query('select public.match_opportunity_to_users(1)')));
    await denied(as(who, (c) => c.query('select public.nexar_confirm_pending_action($1,$2,true)', [U.pro, U.pro])));
  }
  await as('service', (c) => c.query('select * from public.generate_pipeline_reminders()'));
  const opp = (await pool.query(`insert into public.opportunities (poster_id, poster_handle, title) values ($1,'@pro','Server run') returning id`, [U.pro])).rows[0].id;
  await as('service', (c) => c.query('select public.match_opportunity_to_users($1)', [opp]));
});
test('a member posting an opportunity still creates matches and reminders through the trigger', async () => {
  const before = (await pool.query('select count(*)::int n from public.nexar_matches')).rows[0].n;
  const opp = await as('free', (c) => one(c, `insert into public.opportunities (poster_id, poster_handle, title) values ($1,'@free','Design role') returning id`, [U.free]));
  const m = (await pool.query('select count(*)::int n from public.nexar_matches where opportunity_id=$1', [opp.id])).rows[0].n;
  const r = (await pool.query(`select count(*)::int n from public.nexar_reminders r join public.nexar_matches m on m.id=r.match_id where m.opportunity_id=$1`, [opp.id])).rows[0].n;
  assert.equal(m, Object.keys(U).length - 1, 'every member except the poster'); assert.equal(r, m); assert.ok(m > 0 && before >= 0);
});

// ---- Delete requests ----------------------------------------------------------
test('accept deletes the job, records the outcome, and the owner can read it', async () => {
  const job = await addJob(); const id = await request('pro', job);
  const r = await confirm('pro', id, true);
  assert.equal(r.ok, true); assert.equal(r.action, 'deleted'); assert.equal(r.target.id, job);
  assert.equal(await jobExists(job), false);
  const seen = await as('pro', (c) => one(c, 'select outcome from public.nexar_pending_actions where id=$1', [id]));
  assert.equal(seen.outcome, 'deleted');
  assert.equal((await as('pro2', (c) => c.query('select 1 from public.nexar_pending_actions where id=$1', [id]))).rowCount, 0, 'not visible to another member');
});
test('competing answers, one after the other: the first wins and the second is told what was recorded', async () => {
  const job = await addJob(); const id = await request('pro', job);
  assert.equal((await confirm('pro', id, false)).action, 'cancelled');
  const second = await confirm('pro', id, true);
  assert.deepEqual([second.ok, second.error, second.outcome], [false, 'already_resolved', 'cancelled']);
  assert.ok(await jobExists(job));
  const job2 = await addJob(); const id2 = await request('pro', job2);
  assert.equal((await confirm('pro', id2, true)).action, 'deleted');
  const late = await confirm('pro', id2, false);
  assert.deepEqual([late.ok, late.error, late.outcome], [false, 'already_resolved', 'deleted']);
});
test('competing answers at the same moment: exactly one acts, and the record matches the job (40 rounds)', async () => {
  for (let i = 0; i < 40; i++) {
    const job = await addJob(); const id = await request('pro', job);
    const [a, b] = await Promise.all(i % 2 ? [confirm('pro', id, true), confirm('pro', id, false)] : [confirm('pro', id, false), confirm('pro', id, true)]);
    assert.equal([a, b].filter(x => x.ok).length, 1, 'exactly one winner');
    assert.equal([a, b].filter(x => x.error === 'already_resolved').length, 1);
    const o = (await outcome(id)).outcome;
    assert.ok(['deleted', 'cancelled'].includes(o));
    assert.equal(await jobExists(job), o === 'cancelled');
    assert.equal([a, b].find(x => !x.ok).outcome, o, 'loser is told the recorded outcome');
  }
});
test('the same answer sent twice at once deletes once (20 rounds)', async () => {
  for (let i = 0; i < 20; i++) {
    const job = await addJob(); const id = await request('pro', job);
    const rs = await Promise.all([confirm('pro', id, true), confirm('pro', id, true)]);
    assert.equal(rs.filter(x => x.ok && x.action === 'deleted').length, 1);
    assert.equal(rs.filter(x => x.error === 'already_resolved' && x.outcome === 'deleted').length, 1);
  }
});
test('a job edited after the request is not deleted', async () => {
  const job = await addJob(); const id = await request('pro', job);
  await as('pro', (c) => c.query(`update public.nexar_pipeline set status='Interview' where id=$1`, [job]));
  const r = await confirm('pro', id, true);
  assert.deepEqual([r.ok, r.error, r.current.status], [false, 'target_changed', 'Interview']);
  assert.ok(await jobExists(job)); assert.equal((await outcome(id)).outcome, 'target_changed');
});
test('an edit racing the answer: the job is either deleted unedited or kept (30 rounds)', async () => {
  for (let i = 0; i < 30; i++) {
    const job = await addJob(); const id = await request('pro', job);
    const [r, upd] = await Promise.all([confirm('pro', id, true), as('pro', (c) => c.query(`update public.nexar_pipeline set notes='edited' where id=$1 returning id`, [job]))]);
    if (r.ok) { assert.equal(r.action, 'deleted'); assert.equal(await jobExists(job), false); assert.equal(upd.rowCount, 0, 'the edit found no row'); }
    else { assert.equal(r.error, 'target_changed'); assert.ok(await jobExists(job)); assert.equal(upd.rowCount, 1); }
  }
});
test('a newer request replaces older ones; only the newest can delete', async () => {
  const job = await addJob(); const old = await request('pro', job); const mid = await request('pro', job); const latest = await request('pro', job);
  assert.equal((await outcome(old)).outcome, 'superseded'); assert.equal((await outcome(mid)).outcome, 'superseded');
  const r = await confirm('pro', old, true);
  assert.deepEqual([r.ok, r.error, r.outcome], [false, 'already_resolved', 'superseded']); assert.ok(await jobExists(job));
  assert.equal((await confirm('pro', latest, false)).action, 'cancelled'); assert.ok(await jobExists(job));
});
test('two requests for one job made at the same moment leave at most one open (20 rounds)', async () => {
  for (let i = 0; i < 20; i++) {
    const job = await addJob();
    await Promise.allSettled([request('pro', job), request('pro', job)]);
    assert.ok((await pool.query('select count(*)::int n from public.nexar_pending_actions where target_id=$1 and consumed_at is null', [job])).rows[0].n <= 1);
  }
});
test('expired, wrong member, unknown id and already-removed job', async () => {
  const job = await addJob(); const id = await request('pro', job);
  await pool.query(`update public.nexar_pending_actions set expires_at = now() - interval '1 second' where id=$1`, [id]);
  const e = await confirm('pro', id, true); assert.deepEqual([e.ok, e.error], [false, 'expired']); assert.ok(await jobExists(job));

  const id2 = await request('pro', job);
  assert.deepEqual(await confirm('pro2', id2, true), { ok: false, error: 'not_actionable' });
  assert.deepEqual(await confirm('pro', U.free, true), { ok: false, error: 'not_actionable' });
  assert.equal((await outcome(id2)).consumed_at, null, 'another member cannot close it'); assert.ok(await jobExists(job));

  await as('pro', (c) => c.query('delete from public.nexar_pipeline where id=$1', [job]));
  const g = await confirm('pro', id2, true); assert.deepEqual([g.ok, g.action], [true, 'already_gone']);
});
test('a request made before the migration (no recorded job version) cannot delete', async () => {
  const job = await addJob(); const id = await request('pro', job);
  await pool.query('update public.nexar_pending_actions set target_updated_at = null where id=$1', [id]);
  assert.equal((await confirm('pro', id, true)).error, 'target_changed'); assert.ok(await jobExists(job));
});

// ---- Regression: review round 2 ---------------------------------------------------
test('R3 the confirmation text and the expected version come from one reading of the job', async () => {
  // The caller builds its text, the job is then edited, and only then is the request stored.
  const job = await addJob('pro', 'Original title');
  const stale = 'Delete "Original title" @ Lanternworks (Applied)?';
  await as('pro', (c) => c.query(`update public.nexar_pipeline set title='Edited title' where id=$1`, [job]));
  const id = await request('pro', job, stale);
  const row = (await pool.query('select preview, target_snapshot from public.nexar_pending_actions where id=$1', [id])).rows[0];
  assert.equal(row.preview, 'Delete "Edited title" @ Lanternworks (Applied)?', 'the stored text describes the job as stored');
  assert.equal(row.target_snapshot.title, 'Edited title');
  const r = await confirm('pro', id, true);
  assert.equal(r.action, 'deleted'); assert.equal(r.preview, row.preview); assert.equal(r.target.title, 'Edited title');
});
test('R3 any change between the request and the answer is refused, even with an identical timestamp', async () => {
  for (const change of [`title='Changed'`, `company='Changed'`, `status='Offered'`, `notes='Changed'`]) {
    const job = await addJob(); const id = await request('pro', job);
    const c = await pool.connect();
    try {   // bypass the touch trigger so updated_at stays exactly as recorded
      await c.query('begin'); await c.query(`set local session_replication_role = replica`);
      await c.query(`update public.nexar_pipeline set ${change} where id=$1`, [job]); await c.query('commit');
    } finally { c.release(); }
    const same = (await pool.query('select p.updated_at = a.target_updated_at as same from public.nexar_pipeline p, public.nexar_pending_actions a where p.id=$1 and a.id=$2', [job, id])).rows[0].same;
    assert.equal(same, true, 'timestamps are identical in this case');
    const r = await confirm('pro', id, true);
    assert.equal(r.error, 'target_changed', change); assert.ok(await jobExists(job));
  }
});
test('R3 a request cannot be stored for a missing job or another member\'s job', async () => {
  const other = await addJob('pro2');
  await assert.rejects(request('pro', other), (e) => e.code === 'P0002');
  await assert.rejects(request('pro', U.free), (e) => e.code === 'P0002');
});
test('R2 an answer still being processed after the deadline is reported as what it did, never as expired', async () => {
  const job = await addJob(); const id = await request('pro', job);
  await pool.query(`update public.nexar_pending_actions set expires_at = now() + interval '500 milliseconds' where id=$1`, [id]);
  const holder = await pool.connect();
  let answered = false, settled = false;
  try {
    await holder.query('begin'); await holder.query('select 1 from public.nexar_pipeline where id=$1 for update', [job]);   // hold the job
    const answer = confirm('pro', id, true).then((r) => { answered = true; return r; });     // arrives in time, then waits
    await sleep(900);                                                                         // the deadline passes
    assert.equal(answered, false);
    assert.equal((await pool.query('select outcome, expires_at < clock_timestamp() as past from public.nexar_pending_actions where id=$1', [id])).rows[0].past, true);
    const check = settle('pro', id).then((r) => { settled = true; return r; });               // the member's check
    await sleep(300);
    assert.equal(settled, false, 'the check waits for the answer instead of declaring it expired');
    await holder.query('commit');
    const [a, s] = await Promise.all([answer, check]);
    assert.equal(a.action, 'deleted'); assert.equal(s.outcome, 'deleted'); assert.equal(await jobExists(job), false);
  } finally { await holder.query('rollback').catch(() => {}); holder.release(); }
});
test('R2 expiry is recorded only by the server, only for an unanswered request past its deadline, only for its owner', async () => {
  const job = await addJob(); const id = await request('pro', job);
  let s = await settle('pro', id);
  assert.deepEqual([s.found, s.outcome, s.consumed_at], [true, null, null], 'an open request is left open');
  assert.deepEqual(await settle('pro2', id), { found: false }); assert.deepEqual(await settle('free', id), { found: false });
  await denied(settle('anon', id));
  await pool.query(`update public.nexar_pending_actions set expires_at = now() - interval '1 second' where id=$1`, [id]);
  assert.deepEqual(await settle('pro2', id), { found: false }); assert.equal((await outcome(id)).outcome, null, 'another member cannot expire it');
  s = await settle('pro', id); assert.equal(s.outcome, 'expired');
  const late = await confirm('pro', id, true);
  assert.deepEqual([late.ok, late.error, late.outcome], [false, 'already_resolved', 'expired']); assert.ok(await jobExists(job));
  const job2 = await addJob(); const id2 = await request('pro', job2); await confirm('pro', id2, false);
  await pool.query(`update public.nexar_pending_actions set expires_at = now() - interval '1 second' where id=$1`, [id2]);
  assert.equal((await settle('pro', id2)).outcome, 'cancelled', 'a recorded outcome is never rewritten');
});
test('R2 an answer that arrives after the server recorded expiry cannot delete (20 rounds, racing)', async () => {
  for (let i = 0; i < 20; i++) {
    const job = await addJob(); const id = await request('pro', job);
    await pool.query(`update public.nexar_pending_actions set expires_at = now() - interval '1 millisecond' where id=$1`, [id]);
    const [s, a] = await Promise.all([settle('pro', id), confirm('pro', id, true)]);
    assert.equal(a.ok, false); assert.ok(await jobExists(job)); assert.equal((await outcome(id)).outcome, 'expired'); assert.ok(s.found);
  }
});

// ---- Rollback -----------------------------------------------------------------
test('the rollback scripts restore the previous rules, and the migrations re-apply', async () => {
  await pool.query('delete from public.nexar_pending_actions');
  await applyAll('rollback', '.down', [...MIG].reverse());
  await as('free', (c) => c.query('select * from public.generate_pipeline_reminders()'));
  await as('free', (c) => c.query(`insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h','After rollback','Co')`, [U.free]));
  assert.equal((await pool.query(`select count(*)::int n from information_schema.columns where table_name='nexar_pending_actions' and column_name in ('outcome','target_updated_at','target_snapshot')`)).rows[0].n, 0);
  assert.equal((await pool.query(`select count(*)::int n from pg_proc where proname in ('nexar_settle_pending_action','nexar_confirm_pending_action','nexar_pipeline_snapshot','nexar_pending_action_prepare')`)).rows[0].n, 0);
  await applyAll('migrations', '', MIG);
  await denied(as('free', (c) => c.query(`insert into public.nexar_pipeline (user_id, handle, title, company) values ($1,'h','X','Y')`, [U.free])));
});
