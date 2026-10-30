import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { synchronizeAccountAgent } from '../../src/access/account-agent-effect.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { readCandidateDisclosure } from '../../src/semantic/disclosure.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { accountErasureFixture, type AccountErasureFixture } from './support/account-erasure-fixture.ts';

let f: AccountErasureFixture;
beforeAll(async () => {
  f = await accountErasureFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 120_000);
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function subject(who: Awaited<ReturnType<AccountErasureFixture['author']>>) {
  const response = await f.call(who, 'POST', '/v1/subjects', {
    type: 'schema:Person',
    labels: { en: 'Communal person' },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.subject.id as string;
}

test('native T fences anonymous current-owner Context reads with semantic cleanup paused', async () => {
  const owner = await f.author();
  const secret = `Context personal label ${randomUUID()}`;
  const created = await f.call(owner, 'POST', '/v1/contexts', { labels: { en: secret } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.context.id as string;
  const before = await f.call(undefined, 'GET', `/v1/contexts/${id}`);
  expect(before.status).toBe(200);
  expect(JSON.stringify(before.body)).toContain(secret);
  const roles = await f.db.admin.query(
    `SELECT subject_id FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2
     AND grant_role='semantic.context.owner' AND upper_inf(valid)`,
    [routeOf(id), id],
  );
  expect(roles.rows).toEqual([{ subject_id: owner.accountId }]);
  await f.tombstone(owner);
  const after = await f.call(undefined, 'GET', `/v1/contexts/${id}`);
  expect(after.status, JSON.stringify(after.body)).toBe(404);
  expect(JSON.stringify(after.body)).not.toContain(secret);
}, 120_000);

test('native Context physical payload and Semantic editorial provenance remain pending after account T and duplicate label cleanup', async () => {
  const owner = await f.author();
  const labels = { en: `Private owner history ${randomUUID()}` };
  const created = await f.call(owner, 'POST', '/v1/contexts', { labels });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.context.id as string;
  const payload = async () =>
    (
      await f.db.admin.query(
        `SELECT c.labels,c.settings_id,c.settings_release,c.defaults,c.recorded_transaction_id,
            b.principal_kind,b.principal_id,b.client_id,b.requested_by
     FROM semantic.context c JOIN editorial.write_basis b
       ON b.partition_no=($1::integer >> 4) AND b.transaction_id=c.recorded_transaction_id
     WHERE c.route=$1 AND c.context_id=$2`,
        [routeOf(id), id],
      )
    ).rows;
  const before = await payload();
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ labels, principal_kind: 'account', principal_id: owner.accountId });
  const deletion = await f.tombstone(owner);
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  // Clearing an account-agent label cannot minimize the Context or this Semantic-owned provenance row.
  expect(await payload()).toEqual(before);
  expect(await f.status(owner.accountId)).toMatchObject({
    at: deletion.result.at,
    completedAt: null,
    state: 'pending',
    participants: { semantic: { outcome: 'pending', retained: [] } },
  });
  const acknowledgements = await f.db.admin.query(
    `SELECT participant FROM access.erasure_acknowledgement
     WHERE route=$1 AND account_id=$2 AND participant='semantic'`,
    [routeOf(owner.accountId), owner.accountId],
  );
  expect(acknowledgements.rows).toEqual([]);
}, 120_000);

test('native T fences disclosed personal consent at the Semantic source before consumer catchup', async () => {
  const owner = await f.author();
  const id = await subject(owner);
  const proposed = await f.call(owner, 'POST', `/v1/subjects/${id}/candidates`, {
    statement: statement('rezics:penNameOf', accountAgentId(owner.accountId)),
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  const published = await f.call(owner, 'POST', `/v1/statements/${candidate}/disclose`);
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  expect((await readCandidateDisclosure(f.db.pool, { subject: id, candidate }))?.disclosed).toBe(true);
  await f.tombstone(owner);
  expect((await readCandidateDisclosure(f.db.pool, { subject: id, candidate }))?.disclosed).toBe(false);
}, 120_000);

test('native public contribution survives T while real private payload keeps the single participant pending', async () => {
  const owner = await f.author();
  const editor = await f.author();
  await f.grant(GLOBAL_CONTEXT, editor, ['context:accept', 'context:adopt']);
  const id = await subject(owner);
  const payload = `https://example.test/published/${randomUUID()}`;
  const proposed = await f.call(owner, 'POST', `/v1/subjects/${id}/candidates`, {
    statement: {
      ...statement('schema:url', payload),
      references: [{ parts: [statement('schema:url', 'https://example.test/evidence')] }],
    },
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  const accepted = await f.call(editor, 'POST', `/v1/subjects/${id}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const adopted = await f.call(editor, 'POST', `/v1/subjects/${id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:url',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: null,
  });
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
  const privateHolder = await subject(owner);
  const privateProposal = await f.call(owner, 'POST', `/v1/subjects/${privateHolder}/candidates`, {
    statement: statement('rezics:penNameOf', accountAgentId(owner.accountId)),
  });
  expect(privateProposal.status, JSON.stringify(privateProposal.body)).toBe(201);
  const before = await f.call(undefined, 'GET', `/v1/subjects/${id}`);
  expect(before.status).toBe(200);
  expect(JSON.stringify(before.body)).toContain(payload);
  await f.tombstone(owner);
  // This native field-clear effect is partial cleanup, never an all-role erasure ACK.
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  const retained = await f.call(undefined, 'GET', `/v1/subjects/${id}`);
  expect(retained.status).toBe(200);
  expect(JSON.stringify(retained.body)).toContain(payload);
  expect(JSON.stringify(retained.body)).not.toContain(owner.handle);
  const actualPrivateCopy = await f.db.admin.query(
    `SELECT statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
    [routeOf(privateHolder), privateHolder, privateProposal.body.candidate],
  );
  expect(JSON.stringify(actualPrivateCopy.rows)).toContain(accountAgentId(owner.accountId));
  const status = await f.status(owner.accountId);
  expect(status?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
  expect(status?.participants).not.toHaveProperty('zones');
  expect(status?.completedAt).toBeNull();
}, 120_000);

test('native late account source synchronization and duplicate delivery cannot resurrect erased agent labels or acknowledge partial work', async () => {
  const owner = await f.author();
  const agent = accountAgentId(owner.accountId);
  const labels = () =>
    f.db.admin.query(`SELECT body FROM semantic.fact WHERE route=$1 AND subject_id=$2 AND kind='label'`, [
      routeOf(agent),
      agent,
    ]);
  expect(JSON.stringify((await labels()).rows)).toContain(owner.handle);
  await f.tombstone(owner);
  // The committed activation source is now stale; its real producer re-reads current Access state.
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  expect((await labels()).rows).toEqual([]);
  const status = await f.status(owner.accountId);
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  expect((await labels()).rows).toEqual([]);
  expect(await f.status(owner.accountId)).toEqual(status);
  expect(status?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
  const refused = await f.call(owner, 'POST', '/v1/subjects', {
    type: 'schema:Person',
    labels: { en: 'Late producer' },
  });
  expect([401, 403]).toContain(refused.status);
}, 120_000);

test('native coordinator observes actual private candidate and editorial custody pending after partial agent cleanup', async () => {
  const owner = await f.author();
  const id = await subject(owner);
  const proposed = await f.call(owner, 'POST', `/v1/subjects/${id}/candidates`, {
    statement: statement('rezics:penNameOf', accountAgentId(owner.accountId)),
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  const payload = () =>
    f.db.admin.query(
      `SELECT c.statement, r.recorded_transaction_id, b.principal_kind, b.principal_id
     FROM semantic.candidate c
     JOIN semantic.revision r USING(route,subject_id,revision)
     JOIN editorial.write_basis b ON b.partition_no=($1::integer >> 4)
       AND b.transaction_id=r.recorded_transaction_id
     WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$3`,
      [routeOf(id), id, candidate],
    );
  const before = await payload();
  expect(before.rows).toHaveLength(1);
  expect(before.rows[0]).toMatchObject({ principal_kind: 'account', principal_id: owner.accountId });
  expect(JSON.stringify(before.rows[0].statement)).toContain(accountAgentId(owner.accountId));
  await f.tombstone(owner);
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  // Exact fixture-key observation is evidence of an unfulfilled obligation, never a purge implementation.
  expect((await payload()).rows).toEqual(before.rows);
  const status = await f.status(owner.accountId);
  expect(status?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
  expect(status?.participants).not.toHaveProperty('zones');
  expect(status?.completedAt).toBeNull();
  expect(status?.state).toBe('pending');
}, 120_000);

test('native T fences a live moderator private candidate overlay while retaining the communal subject', async () => {
  const owner = await f.author();
  const moderator = await f.author();
  await f.grant(GLOBAL_CONTEXT, moderator, ['moderation:hide']);
  const id = await subject(owner);
  const agent = accountAgentId(owner.accountId);
  const proposed = await f.call(owner, 'POST', `/v1/subjects/${id}/candidates`, {
    statement: statement('rezics:penNameOf', agent),
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const path = `/v1/subjects/${id}/candidates?property=rezics%3ApenNameOf&target=${agent}`;
  const before = await f.call(moderator, 'GET', path);
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(JSON.stringify(before.body)).toContain(proposed.body.candidate);
  await f.tombstone(owner);
  const after = await f.call(moderator, 'GET', path);
  expect(after.status, JSON.stringify(after.body)).toBe(200);
  expect(JSON.stringify(after.body)).not.toContain(proposed.body.candidate);
  expect(JSON.stringify(after.body)).not.toContain(agent);
  const communal = await f.call(undefined, 'GET', `/v1/subjects/${id}`);
  expect(communal.status, JSON.stringify(communal.body)).toBe(200);
  expect(communal.body.subject.id).toBe(id);
}, 120_000);

test('native acceptor erasure accounts for editorial roles independently of the surviving proposal author', async () => {
  const author = await f.author();
  const acceptor = await f.author();
  await f.grant(GLOBAL_CONTEXT, acceptor, ['context:accept']);
  const id = await subject(author);
  const proposed = await f.call(author, 'POST', `/v1/subjects/${id}/candidates`, {
    statement: {
      ...statement('schema:url', `https://example.test/role/${randomUUID()}`),
      references: [{ parts: [statement('schema:url', 'https://example.test/evidence')] }],
    },
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  const accepted = await f.call(acceptor, 'POST', `/v1/subjects/${id}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const provenance = () =>
    f.db.admin.query(
      `SELECT b.principal_id,r.recorded_transaction_id
     FROM semantic.acceptance a
     JOIN semantic.revision r USING(route,subject_id,revision)
     JOIN editorial.write_basis b ON b.partition_no=($1::integer >> 4)
       AND b.transaction_id=r.recorded_transaction_id
     WHERE a.route=$1 AND a.subject_id=$2 AND a.context_id=$3 AND a.candidate_id=$4 AND a.head=1`,
      [routeOf(id), id, GLOBAL_CONTEXT, candidate],
    );
  const before = await provenance();
  expect(before.rows).toHaveLength(1);
  expect(before.rows[0].principal_id).toBe(acceptor.accountId);
  await f.tombstone(acceptor);
  await synchronizeAccountAgent(f.db.pool, acceptor.accountId);
  // An existing editorial role is actual applicable data even though this person did not propose the candidate.
  expect((await provenance()).rows).toEqual(before.rows);
  expect((await f.status(acceptor.accountId))?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
  expect(await f.status(author.accountId)).toBeNull();
  expect((await f.call(author, 'GET', `/v1/subjects/${id}`)).status).toBe(200);
}, 120_000);

test('native candidate source, editorial provenance and exact shared copy keys stay pending together after duplicate partial cleanup', async () => {
  const owner = await f.author();
  const id = await subject(owner);
  const key = randomUUID();
  const proposed = await f.call(
    owner,
    'POST',
    `/v1/subjects/${id}/candidates`,
    {
      statement: statement('rezics:penNameOf', accountAgentId(owner.accountId)),
    },
    { 'idempotency-key': JSON.stringify(key) },
  );
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  const source = await f.db.admin.query(
    `SELECT c.statement,r.recorded_transaction_id,b.partition_no,b.position,b.principal_id,b.requested_by
     FROM semantic.candidate c JOIN semantic.revision r USING(route,subject_id,revision)
     JOIN editorial.write_basis b ON b.partition_no=($1::integer >> 4)
       AND b.transaction_id=r.recorded_transaction_id
     WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$3`,
    [routeOf(id), id, candidate],
  );
  expect(source.rows).toHaveLength(1);
  const basis = source.rows[0];
  expect(basis.principal_id).toBe(owner.accountId);
  expect(JSON.stringify(basis.statement)).toContain(accountAgentId(owner.accountId));
  // These are exact observations of real copies, not an exported locator or a minimization receipt.
  const copies = async () => ({
    receipt: (
      await f.db.admin.query(
        `SELECT principal_kind,principal_id,command_kind,idempotency_key,transaction_id,response,request_digest
       FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
         AND idempotency_key=$3`,
        [basis.partition_no, owner.accountId, key],
      )
    ).rows,
    events: (
      await f.db.admin.query(
        `SELECT event_seq,type,subject,data FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq`,
        [basis.partition_no, basis.position],
      )
    ).rows,
    provenance: (
      await f.db.admin.query(
        `SELECT principal_id,client_id,requested_by FROM editorial.write_basis
       WHERE partition_no=$1 AND transaction_id=$2`,
        [basis.partition_no, basis.recorded_transaction_id],
      )
    ).rows,
  });
  const before = await copies();
  expect(before.receipt).toHaveLength(1);
  expect(before.receipt[0].transaction_id).toBe(basis.recorded_transaction_id);
  expect(JSON.stringify(before.receipt[0].response)).toContain(candidate);
  expect(before.events.length).toBeGreaterThan(0);
  expect(before.provenance).toHaveLength(1);
  const deletion = await f.tombstone(owner);
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  await synchronizeAccountAgent(f.db.pool, owner.accountId);
  expect(await copies()).toEqual(before);
  const local = await f.db.admin.query(
    'SELECT statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
    [routeOf(id), id, candidate],
  );
  expect(local.rows).toEqual([{ statement: basis.statement }]);
  const status = await f.status(owner.accountId);
  expect(status?.at).toBe(deletion.result.at);
  expect(status?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
  expect(status?.participants['shared-history']).toEqual({ outcome: 'pending', retained: [] });
  expect(status?.completedAt).toBeNull();
}, 120_000);
