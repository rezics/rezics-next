import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore, migrateContent, type VariantIdentity } from '../../content/src/index.ts';
import { ContentProtectionStore, ProtectionIdempotencyConflict, type CorrectionProposal }
  from '../src/modules/protection/content-store.ts';
import { PROTECTION_RULE } from '../src/modules/protection/schema.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `protection-store-${randomUUID()}`);
const data = join(state, 'pgdata');
const socket = join(root, '.temp', 'pg-sock');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let pool: Pool;
let store: ContentProtectionStore;
let content: ContentCore;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 8 });
  await migrateContent(pool);
  store = new ContentProtectionStore(pool);
  content = new ContentCore(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
  finally { rmSync(state, { recursive: true, force: true }); }
});

async function target(body = 'one') {
  const variant: VariantIdentity = { id: `urn:rezics:variant:${randomUUID()}`, resourceId: `https://rezics.com/id/${randomUUID()}`,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' };
  const saved = await content.saveDraft({ operationId: `save-${randomUUID()}`, variant, expectedHead: null,
    model: 'content-shape-v1', sourceRevision: null, provenance: { editor: 'test' }, serializedJson: JSON.stringify({ body }) });
  return { variant, head: saved.revisionId! };
}
const basis = (t: { variant: VariantIdentity }, head: string, protection: string | null, operationId = `op-${randomUUID()}`) => ({
  operationId, requestDigest: sha(operationId), resourceId: t.variant.resourceId, variantId: t.variant.id,
  expectedContentHead: head, expectedProtectionHead: protection, expectedRuleRevision: PROTECTION_RULE,
  reason: 'Repeated vandalism', evidence: ['urn:rezics:evidence:report'], agent: null });
const proposerKey = (principal: string) => (proposal: string) => sha(`${proposal}\0${principal}`);
const propose = (t: { variant: VariantIdentity }, head: string, protection: string | null, body: string,
  principal = 'proposer', predecessor: string | null = null, operationId?: string) => store.proposeCorrection({
  ...basis(t, head, protection, operationId), candidateJson: JSON.stringify({ body }), predecessor,
  proposerKey: proposerKey(principal) });
const decide = (proposal: CorrectionProposal, outcome: 'approved' | 'rejected', principal = 'reviewer',
  operationId = `op-${randomUUID()}`) => store.decideCorrection({ operationId, requestDigest: sha(operationId),
  proposalRevision: proposal.proposalRevision, outcome, expectedCandidateDigest: proposal.candidateDigest,
  expectedContentHead: proposal.baseHead, expectedProtectionHead: proposal.baseProtection,
  expectedRuleRevision: PROTECTION_RULE, independenceProof: `urn:rezics:admission:${randomUUID()}`,
  reviewerKey: proposerKey(principal), reason: 'Checked against the edition', evidence: [], agent: null });
const heads = async (variant: string) => (await store.editorialStates([variant]))[0]!;
const receipts = async (operationId: string) => (await pool.query<{ outcome: string; reason: string | null; sequence: string }>(
  'SELECT outcome, reason, sequence::text FROM content.receipt WHERE operation_id = $1', [operationId])).rows;
const events = async (operationId: string) => Number((await pool.query<{ n: string }>(
  'SELECT count(*) AS n FROM content.outbox WHERE operation_id = $1', [operationId])).rows[0]!.n);

test('SYS03/SYS10/SYS14: the owner receipt, not sequence progress, decides a protection outcome', async () => {
  const t = await target();
  const tighten = await store.changeProtection({ ...basis(t, t.head, null), action: 'tighten' });
  expect(tighten).toMatchObject({ outcome: 'succeeded', code: null, replayed: false, value: { epoch: '1', mode: 'review-required' } });
  const protection = tighten.value!.id;
  // Same identity replays; the same identity with another digest never rewrites it.
  const again = await store.changeProtection({ ...basis(t, t.head, null, tighten.operationId), action: 'tighten' });
  expect(again).toEqual({ ...tighten, replayed: true });
  await expect(store.changeProtection({ ...basis(t, t.head, null, tighten.operationId), action: 'tighten',
    requestDigest: sha('other') })).rejects.toBeInstanceOf(ProtectionIdempotencyConflict);
  expect(await receipts(tighten.operationId)).toHaveLength(1);

  // A confirmation prepared at the old absent basis is stale; unrelated commits advance the sequence first.
  const stale = basis(t, t.head, null);
  for (let i = 0; i < 3; i++) await target(`unrelated ${i}`);
  const rejected = await store.changeProtection({ ...stale, action: 'confirm' });
  expect(rejected).toMatchObject({ outcome: 'rejected', code: 'stale_protection', value: null });
  expect(await receipts(stale.operationId)).toEqual([{ outcome: 'stale_head', reason: 'stale_protection',
    sequence: rejected.position.sequence }]);
  expect(await events(stale.operationId)).toBe(1);
  // Even after the basis would match again, the recorded terminal outcome is returned.
  expect(await store.changeProtection({ ...stale, action: 'confirm' })).toEqual({ ...rejected, replayed: true });
  expect(await heads(t.variant.id)).toMatchObject({ contentHead: t.head, protection: { id: protection, epoch: '1' } });

  // Edit wins first: an old-basis confirmation cannot confirm the newer head.
  const other = await target();
  const edited = await content.saveDraft({ operationId: `save-${randomUUID()}`, variant: other.variant, expectedHead: other.head,
    model: 'content-shape-v1', sourceRevision: null, provenance: { editor: 'test' }, serializedJson: '{"body":"two"}' });
  expect((await store.changeProtection({ ...basis(other, other.head, null), action: 'confirm' })).code).toBe('stale_content');
  expect(await heads(other.variant.id)).toMatchObject({ contentHead: edited.revisionId, protection: null, effectiveMode: 'open' });

  // Absent and relaxed protection differ; relaxation is appended and cannot repeat.
  expect((await store.changeProtection({ ...basis(t, t.head, protection), action: 'tighten' })).code).toBe('unsupported_transition');
  expect((await store.changeProtection({ ...basis(t, t.head, protection), action: 'relax',
    expectedRuleRevision: 'urn:rezics:protection-rule:other' })).code).toBe('stale_rule');
  const relaxed = await store.changeProtection({ ...basis(t, t.head, protection), action: 'relax' });
  expect(relaxed.value).toMatchObject({ epoch: '2', mode: 'open' });
  expect((await store.changeProtection({ ...basis(t, t.head, relaxed.value!.id), action: 'relax' })).code)
    .toBe('unsupported_transition');
  expect(await heads(t.variant.id)).toMatchObject({ protection: { id: relaxed.value!.id }, effectiveMode: 'open' });
}, 60_000);

test('SYS02/SYS11/SYS14/GOV03: one terminal decision and one application, whichever request wins', async () => {
  const t = await target();
  const protection = (await store.changeProtection({ ...basis(t, t.head, null), action: 'confirm' })).value!.id;
  const first = (await propose(t, t.head, protection, 'fixed')).value!;
  expect(await heads(t.variant.id)).toMatchObject({ contentHead: t.head, protection: { id: protection } });

  // The proposer cannot review through another Agent; the key is the private principal.
  expect((await decide(first, 'approved', 'proposer')).code).toBe('reviewer_not_independent');
  // A changed candidate digest cannot retarget the decision.
  expect((await store.decideCorrection({ ...(await decideInput(first)), expectedCandidateDigest: 'f'.repeat(64) })).code)
    .toBe('stale_review_basis');

  // Lost response: the committed approval is replayed by its identity; a new key has no second effect.
  const operationId = `op-${randomUUID()}`;
  const approved = await decide(first, 'approved', 'reviewer', operationId);
  expect(approved.value).toMatchObject({ outcome: 'approved', application: { baseHead: t.head,
    successorHead: first.candidateRevision, protectionHead: protection } });
  expect(await decide(first, 'approved', 'reviewer', operationId)).toEqual({ ...approved, replayed: true });
  const repeat = await decide(first, 'approved');
  expect(repeat).toMatchObject({ outcome: 'rejected', code: 'decision_exists' });
  expect(await heads(t.variant.id)).toMatchObject({ contentHead: first.candidateRevision, protection: { id: protection } });
  expect(Number((await pool.query('SELECT count(*) FROM content.correction_application WHERE variant_id = $1',
    [t.variant.id])).rows[0].count)).toBe(1);

  // Concurrent approve and reject under different keys: one terminal decision.
  const second = (await propose(t, first.candidateRevision, protection, 'second')).value!;
  const raced = await Promise.all([decide(second, 'approved'), decide(second, 'rejected')]);
  expect(raced.map(result => result.outcome).sort()).toEqual(['rejected', 'succeeded']);
  expect(raced.find(result => result.outcome === 'rejected')!.code).toBe('decision_exists');

  // Delayed effect versus terminal cancellation under the same identity: one winner.
  const third = (await propose(t, (await heads(t.variant.id)).contentHead!, protection, 'third')).value!;
  for (const cancelFirst of [true, false]) {
    const proposal = cancelFirst ? third : (await propose(t, (await heads(t.variant.id)).contentHead!, protection, 'fourth')).value!;
    const id = `op-${randomUUID()}`;
    const run = () => decide(proposal, 'approved', 'reviewer', id);
    const cancel = () => store.cancel('correction.decide', id, sha(id));
    const [a, b] = cancelFirst ? [await cancel(), await run()] : await Promise.all([run(), cancel()]);
    const winner = cancelFirst ? a : (a.replayed ? b : a);
    expect([a.outcome, b.outcome]).toEqual([winner.outcome, winner.outcome]);
    expect(await receipts(id)).toHaveLength(1);
    const decided = (await store.readCorrection(proposal.proposalRevision))!.decision;
    expect(decided === null).toBe(winner.code === 'cancelled');
    if (cancelFirst) expect(winner.code).toBe('cancelled');
  }

  // A rejected revision is changed only by a new revision on the current basis; applied revisions stay final.
  const current = await heads(t.variant.id);
  const rejectedProposal = (await propose(t, current.contentHead!, protection, 'reject me')).value!;
  expect((await decide(rejectedProposal, 'rejected')).value).toMatchObject({ outcome: 'rejected', application: null });
  const revised = await propose(t, current.contentHead!, protection, 'revised', 'proposer', rejectedProposal.proposalRevision);
  expect(revised.value).toMatchObject({ proposal: rejectedProposal.proposal, revisionNumber: 2 });
  expect((await propose(t, current.contentHead!, protection, 'undo', 'proposer', first.proposalRevision)).code)
    .toBe('stale_review_basis');
  expect((await store.readCorrection(rejectedProposal.proposalRevision))).toMatchObject({
    decision: { outcome: 'rejected' }, candidateAvailable: true });
}, 60_000);

async function decideInput(proposal: CorrectionProposal) {
  const operationId = `op-${randomUUID()}`;
  return { operationId, requestDigest: sha(operationId), proposalRevision: proposal.proposalRevision, outcome: 'approved' as const,
    expectedCandidateDigest: proposal.candidateDigest, expectedContentHead: proposal.baseHead,
    expectedProtectionHead: proposal.baseProtection, expectedRuleRevision: PROTECTION_RULE,
    independenceProof: `urn:rezics:admission:${randomUUID()}`, reviewerKey: proposerKey('reviewer'),
    reason: 'Checked', evidence: [], agent: null };
}

test('protection reads are bounded: 50 targets, 50-entry pages and an exact continuation', async () => {
  const t = await target();
  const ids: string[] = [];
  for (let i = 0; i < 51; i++) ids.push((await propose(t, t.head, null, `candidate ${i}`)).value!.proposalRevision);
  const first = await store.listCorrections(t.variant.id, null);
  expect(first.items).toHaveLength(50);
  const rest = await store.listCorrections(t.variant.id, first.next);
  expect(rest).toMatchObject({ next: null });
  expect(new Set([...first.items, ...rest.items].map(item => item.proposalRevision))).toEqual(new Set(ids));
  await expect(store.listCorrections(t.variant.id, null, 51)).rejects.toThrow('invalid page');
  const many = Array.from({ length: 51 }, () => `urn:rezics:variant:${randomUUID()}`);
  await expect(store.editorialStates(many)).rejects.toThrow('at most 50');
  expect(await store.editorialStates([...many.slice(0, 49), t.variant.id])).toHaveLength(1);
}, 60_000);
