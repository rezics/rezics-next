import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  admitted,
  concealed,
  createOriginal,
  effectSnapshot,
  merge,
  personalSnapshot,
  quotedKey,
  revokeMerge,
  savePersonalOriginal,
  seedGroup,
  withIdentityHttp,
} from './support/identity-operations-http.ts';

// Specification acceptance: execute the mounted API before inspecting missing epoch producers.
// The exact crash/ACK matrix remains NOT YET FROZEN in identity-epoch-contract.md.
// There is no successful participant adapter, caller completion switch or skipped test here.

test(
  'merge admission returns one durable operation with same-key replay and different-body conflict',
  () =>
    withIdentityHttp(async (d) => {
      const subjects = [await createOriginal(d), await createOriginal(d)];
      const other = await createOriginal(d, 'Different duplicate');
      const key = quotedKey();
      const first = await merge(d, subjects, key);
      const operation = admitted(first);
      const receipt = await d.fixtures.pool.query(
        `SELECT partition_no,epoch,position,transaction_id,response
      FROM core.receipt WHERE command_kind='subject.merge' AND idempotency_key=$1`,
        [JSON.parse(key)],
      );
      expect(receipt.rows).toHaveLength(1);
      expect(receipt.rows[0].response).toEqual(first.body);
      expect(receipt.rows[0].transaction_id).toEqual(expect.any(String));
      const before = await effectSnapshot(d);
      const replay = await merge(d, subjects, key);
      expect(admitted(replay)).toEqual(operation);
      expect(replay.body).toEqual(first.body);
      const conflict = await merge(d, [subjects[0]!, other], key);
      expect(conflict.status).toBe(422);
      expect(conflict.body).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
      expect(await effectSnapshot(d)).toEqual(before);
      const saved = await d.fixtures.pool.query(
        `SELECT partition_no,epoch,position,transaction_id,response
      FROM core.receipt WHERE command_kind='subject.merge' AND idempotency_key=$1`,
        [JSON.parse(key)],
      );
      // Compare native transaction identity AND component: noEffect can reuse a position.
      expect(saved.rows).toEqual(receipt.rows);
    }),
  180_000,
);

test(
  'currently authorized pending poll exposes only operation id and done false',
  () =>
    withIdentityHttp(async (d) => {
      const subjects = [await createOriginal(d), await createOriginal(d)];
      const { id, location } = admitted(await merge(d, subjects));
      const poll = await d.request('acceptor', 'GET', location);
      expect(poll.status, JSON.stringify(poll.body)).toBe(200);
      expect(poll.body).toEqual({ operation: { id, done: false } });
      // No affected-original vector, private participant details or provisional result.
      const unknown = await d.request('acceptor', 'GET', `/v1/subjectIdentityOperations/${randomUUID()}`);
      concealed(unknown);
      const denied = await d.request('editor', 'GET', location);
      expect(concealed(denied)).toEqual(concealed(unknown));
    }),
  180_000,
);

test(
  'polling after current merge grant revocation is concealed and denied replay has no identity effects',
  () =>
    withIdentityHttp(async (d) => {
      const subjects = [await createOriginal(d), await createOriginal(d)];
      const key = quotedKey();
      const first = await merge(d, subjects, key);
      await revokeMerge(d);
      const before = await effectSnapshot(d);
      const denied = await merge(d, subjects, key);
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      expect(denied.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
      expect(await effectSnapshot(d)).toEqual(before);
      const { location } = admitted(first);
      const poll = await d.request('acceptor', 'GET', location);
      const unknown = await d.request('acceptor', 'GET', `/v1/subjectIdentityOperations/${randomUUID()}`);
      expect(concealed(poll)).toEqual(concealed(unknown));
      expect(await effectSnapshot(d)).toEqual(before);
    }),
  180_000,
);

test(
  'polling a hidden original cannot disclose its public terminal or operation result',
  () =>
    withIdentityHttp(async (d) => {
      const subjects = [await createOriginal(d), await createOriginal(d)].sort();
      const { location } = admitted(await merge(d, subjects));
      await d.grant('editor', ['moderation:hide'], d.globalContext);
      const hidden = await d.request(
        'editor',
        'POST',
        `/v1/subjects/${subjects[1]}:hide`,
        { reason: 'Withhold the original after admission' },
        { 'Idempotency-Key': quotedKey() },
      );
      expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
      const poll = await d.request('acceptor', 'GET', location);
      const unknown = await d.request('acceptor', 'GET', `/v1/subjectIdentityOperations/${randomUUID()}`);
      expect(concealed(poll)).toEqual(concealed(unknown));
    }),
  180_000,
);

test(
  'cap4097 rejects before any pending job control epoch revision redirect receipt or outbox effects',
  () =>
    withIdentityHttp(async (d) => {
      const subjects = [await createOriginal(d), await createOriginal(d)].sort();
      const left = await seedGroup(d, subjects[0]!, 2047);
      const right = await seedGroup(d, subjects[1]!, 2048);
      expect(new Set([...subjects, ...left, ...right]).size).toBe(4097);
      const before = await effectSnapshot(d);
      const overflow = await merge(d, subjects);
      const after = await effectSnapshot(d);
      expect(overflow.status, `native overflow POST: ${JSON.stringify(overflow.body)}`).toBe(409);
      expect(overflow.body).toMatchObject({ code: 'identity_group_overflow', effect_status: 'not_applied' });
      expect(after, 'overflow must precede ALL identity admission and structural effects').toEqual(before);
    }),
  180_000,
);

test(
  'fresh unrelated revision1 creation remains usable without Search while an identity operation is pending',
  () =>
    withIdentityHttp(async (d) => {
      const subjects = [await createOriginal(d), await createOriginal(d)];
      const { id, location } = admitted(await merge(d, subjects));
      const pending = await d.request('acceptor', 'GET', location);
      expect(pending.status).toBe(200);
      expect(pending.body).toEqual({ operation: { id, done: false } });
      const fresh = await createOriginal(d, 'Unrelated new book');
      expect((await d.inspect.revisions(fresh)).map((r) => r.revision)).toEqual([1]);
      const read = await d.request('editor', 'GET', `/v1/subjects/${fresh}`);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body.subject).toMatchObject({ id: fresh, revision: 1 });
      expect((await d.request('acceptor', 'GET', location)).body).toEqual({ operation: { id, done: false } });
    }),
  180_000,
);

test(
  'admission and replay preserve stored follows entries and repeated Collection occurrences',
  () =>
    withIdentityHttp(async (d) => {
      const subjects = [await createOriginal(d), await createOriginal(d)].sort();
      const stored = await savePersonalOriginal(d, subjects[1]!);
      const key = quotedKey();
      const first = await merge(d, subjects, key);
      expect(await personalSnapshot(d)).toEqual(stored);
      const operation = admitted(first);
      expect(admitted(await merge(d, subjects, key))).toEqual(operation);
      expect(await personalSnapshot(d)).toEqual(stored);
    }),
  180_000,
);

test(
  'a valid natively suspended bearer receives403 rather than an authentication or anonymous response',
  () =>
    withIdentityHttp(async (d) => {
      const subjects = [await createOriginal(d), await createOriginal(d)];
      // The shared Accounts producer registers, issues the bearer, then calls actual suspension.
      // Never simulate suspension by editing account rows, tokens or Access decisions.
      const before = await effectSnapshot(d);
      const suspended = await d.request(
        'suspended',
        'POST',
        '/v1/subjects:merge',
        { subjects },
        { 'Idempotency-Key': quotedKey() },
      );
      expect(suspended.status, JSON.stringify(suspended.body)).toBe(403);
      expect(suspended.body.code).toBe('account_suspended');
      expect(await effectSnapshot(d)).toEqual(before);
    }),
  180_000,
);

test(
  'unknown operation GET is concealed and valid suspended polling receives403',
  () =>
    withIdentityHttp(async (d) => {
      const location = `/v1/subjectIdentityOperations/${randomUUID()}`;
      // Exercise the actual GET boundary even while POST still exposes the absent async binding.
      concealed(await d.request('acceptor', 'GET', location));
      const suspended = await d.request('suspended', 'GET', location);
      expect(suspended.status, JSON.stringify(suspended.body)).toBe(403);
      expect(suspended.body.code).toBe('account_suspended');
    }),
  180_000,
);
