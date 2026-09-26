import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { titleControlFixture } from '../fixtures/title-control.ts';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { strongRevokeWorkScope } from '../../../services/main/src/modules/work/strong-revoke.ts';

type Fixture = Awaited<ReturnType<typeof titleControlFixture>>;
interface Edited { revision: string; sourcePosition: { sequence: string }; replayed: boolean }

/** Receipts naming one Work revision, with their outcome and outbox events. */
async function receiptsFor(f: Fixture, revision: string) {
  const result = await f.nativeFuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?digest (COUNT(?event) AS ?events) WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:workRevision ${iri(revision)} ; rv:requestDigest ?digest }
    OPTIONAL { GRAPH ${iri(GRAPHS.outbox)} { ?event rv:receipt ?receipt } } } GROUP BY ?receipt ?digest`);
  return (result.results?.bindings ?? []).map(row => ({ receipt: row.receipt!.value, digest: row.digest!.value,
    events: Number(row.events!.value) }));
}
async function receiptOutcome(f: Fixture, receipt: string) {
  const result = await f.nativeFuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:outcome ?outcome } }`);
  return (result.results?.bindings ?? []).map(row => row.outcome!.value.replace(RV, ''));
}
const datasetSequence = async (f: Fixture) => BigInt((await f.nativeFuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
  GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }`)).results!.bindings[0]!.n!.value);
const scopeEpoch = async (f: Fixture, scope: string) => (await f.accessPool.query<{ authority_epoch: string }>(
  'SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1', [scope])).rows[0]!.authority_epoch;

async function adoptedWork(f: Fixture, id: string) {
  const work = await f.adoptWork(await f.propose(id, undefined, `Source title ${id}`));
  await f.grantWork(work.work);
  return work;
}

test('SYS02/SYS03/SYS10/SYS11/SYS14: Jena title receipts decide outcomes, not transport, sequence or zero-match updates', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const f = await titleControlFixture(Bun.env as Record<string, string>, resolve('.temp', `receipts-${randomUUID()}`));
  try {
    const work = await adoptedWork(f, 'OL881001W');
    const other = await adoptedWork(f, 'OL881002W');

    // SYS02: the Jena commit succeeds but its acknowledgement is lost; the receipt resolves it.
    const key = randomUUID();
    const initial = await f.state(work.work);
    f.loseTitle();
    const first = await f.json<Edited>(await f.edit(initial, 'Human title', key), 200);
    const retried = await f.json<Edited>(await f.edit(initial, 'Human title', key), 200);
    expect(retried).toEqual({ ...first, replayed: true });
    const [own] = await receiptsFor(f, first.revision);
    expect(await receiptsFor(f, first.revision)).toEqual([{ receipt: own!.receipt, digest: own!.digest, events: 1 }]);
    // SYS14: the same key with another digest conflicts and never rewrites the recorded request.
    expect((await f.edit(await f.state(work.work), 'Changed intent', key)).status).toBe(409);
    expect(await receiptsFor(f, first.revision)).toEqual([own]);
    expect((await f.state(work.work)).contentHead).toBe(first.revision);

    // SYS03: unrelated commits alone advance the dataset sequence without deciding this CAS.
    const held = await f.state(work.work);
    const unrelated = await f.state(other.work);
    f.beforeTitle(async () => {
      await f.json(await f.edit(unrelated, 'Unrelated title'), 200);
    });
    const advanced = await f.json<Edited>(await f.edit(held, 'Still exact'), 200);
    expect(BigInt(advanced.sourcePosition.sequence)).toBeGreaterThan(BigInt(first.sourcePosition.sequence) + 1n);

    // SYS03/SYS10: a prepared command whose basis changed matches no guard, even as the sequence advances.
    const stale = await f.state(work.work);
    let raw: Awaited<ReturnType<FusekiClient['command']>> | undefined, rawReceipt = '', rawOutcome: string[] = [];
    let before = 0n, after = 0n;
    f.beforeTitle(async command => {
      await f.json(await f.edit(stale, 'Winning edit'), 200);
      await f.json(await f.edit(await f.state(other.work), 'Another unrelated title'), 200);
      before = await datasetSequence(f);
      rawReceipt = command.receipt;
      raw = await f.nativeFuseki.command(command);
      after = await datasetSequence(f);
      rawOutcome = await receiptOutcome(f, rawReceipt);
    });
    const loser = await f.edit(stale, 'Losing edit');
    expect(loser.status).toBe(409);
    // The module refuses the changed basis; nothing commits and no receipt is written for it.
    expect(['guard-unmatched', 'invalid']).toContain(raw!.status);
    expect(after).toBe(before);
    expect(rawOutcome).toEqual([]);
    expect(await receiptOutcome(f, rawReceipt)).toEqual(['Cancelled']);
    const winner = await f.state(work.work);
    expect(winner.contentHead).not.toBe(stale.contentHead);
    expect(BigInt(winner.basis.epoch)).toBe(BigInt(stale.basis.epoch) + 1n);

    // SYS10/SYS11: a delayed title update loses to strong revocation's cancellation of the same
    // receipt. Its conditional update then matches no guard; only the own receipt decides.
    const scope = `work:edit:${work.work}`;
    let revokedReceipt = '', delayed: typeof raw, sequence = [0n, 0n];
    f.beforeTitle(async command => {
      revokedReceipt = command.receipt;
      const progress = await strongRevokeWorkScope(f.env, f.access, scope, await scopeEpoch(f, scope));
      expect(progress).toMatchObject({ status: 'complete', pending: 0 });
      sequence = [await datasetSequence(f), 0n];
      delayed = await f.nativeFuseki.command(command);
      sequence[1] = await datasetSequence(f);
    });
    expect((await f.edit(winner, 'Delayed edit')).status).toBe(409);
    // The transport may report a successful HTTP command for a zero-match update.
    // The unchanged sequence and our own cancellation receipt decide the outcome.
    expect(['guard-unmatched', 'committed']).toContain(delayed!.status);
    expect(sequence[1]).toBe(sequence[0]);
    expect(await receiptOutcome(f, revokedReceipt)).toEqual(['Cancelled']);
    expect((await f.state(work.work)).contentHead).toBe(winner.contentHead);

    // SYS11: when cancellation cannot be made durable, revocation stays pending and the in-flight
    // effect remains the single winner of its receipt.
    const third = await adoptedWork(f, 'OL881003W');
    const thirdScope = `work:edit:${third.work}`;
    const unavailable = new Proxy(f.env.fuseki, { get(target, property) {
      if (property === 'query' || property === 'commandWithReceipt') return async () => { throw new Error('graph unavailable'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as FusekiClient;
    let fenced = '';
    f.beforeTitle(async () => {
      const progress = await strongRevokeWorkScope({ ...f.env, fuseki: unavailable }, f.access, thirdScope,
        await scopeEpoch(f, thirdScope));
      expect(progress).toMatchObject({ status: 'pending', pending: 1 });
      fenced = progress.authorityEpoch;
    });
    const committed = await f.json<Edited>(await f.edit(await f.state(third.work), 'In-flight edit'), 200);
    expect(await strongRevokeWorkScope(f.env, f.access, thirdScope, fenced)).toMatchObject({ status: 'complete', pending: 0 });
    const [inFlight] = await receiptsFor(f, committed.revision);
    expect(await receiptOutcome(f, inFlight!.receipt)).toEqual(['Succeeded']);
    expect((await f.edit(await f.state(third.work), 'After revocation')).status).not.toBe(200);
  } finally { await f.close(); }
}, 240_000);
