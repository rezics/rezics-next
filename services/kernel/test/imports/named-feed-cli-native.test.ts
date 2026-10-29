import { expect, test } from 'bun:test';
import type { BatchCommand, BatchStatement, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../../packages/conversion/src/open-library.ts';
import { openNamedFeeds, commands, work, edition, control, type Exchange } from './named-feed-cli-native-fixture.ts';

const relation = 'schema:exampleOfWork';
const a = 'books-a';
const b = 'books-b';
type Propose = Extract<BatchCommand, { op: 'propose' }>;
function proposal(exchanges: readonly Exchange[], key: string, property: string) {
  const found = commands(exchanges).find(
    (c): c is Propose => c.op === 'propose' && c.source.external_id === key && c.statement.property.id === property,
  );
  if (!found) throw new Error(`Missing actual ${property} proposal`);
  return found;
}
function completed(run: Awaited<ReturnType<Awaited<ReturnType<typeof openNamedFeeds>>['invoke']>>) {
  expect(run.code, JSON.stringify({ stdout: run.stdout, stderr: run.stderr })).toBe(0);
  expect(run.stderr).toBe('');
  expect(run.consumed).toBe(Buffer.byteLength(run.bytes));
  for (const exchange of run.exchanges) {
    expect(exchange.status, exchange.response).toBe(200);
    if (exchange.path === '/v1/subjects:batchWrite') {
      for (const result of (JSON.parse(exchange.response) as BatchWriteResult).results)
        expect([200, 201]).toContain(result.status);
    }
  }
}
function selected(body: { subject: { statements: { [key: string]: BatchStatement[] } } }, property: string) {
  return body.subject.statements[property]?.map((s) => s.value);
}

test('one operator imports two configured feeds with the same native work keys while ordinary CLI references fences replay and durable ownership remain confined to the selected alias', async () => {
  const f = await openNamedFeeds();
  try {
    const firstA = await f.invoke(a, [work, control]);
    completed(firstA);
    const aw = f.claim(a, work.key);
    const ac = f.claim(a, control.key);
    const initialA = f.snapshot(a, [work.key, control.key]);
    expect(initialA.source?.present_count).toBe(2);
    const aBootstrap = f.bootstrap(a, work.key);

    // A's real claim is already durable in the SAME file when B imports its edition.
    const firstB = await f.invoke(b, [edition]);
    completed(firstB);
    const be = f.claim(b, edition.key);
    expect(f.snapshot(b, [work.key]).records[0]!.claim).toBeNull();
    const oldProposal = proposal(firstB.exchanges, edition.key, relation);
    expect(oldProposal.statement.value).toEqual({ type: 'somevalue' });
    expect(oldProposal.statement.qualifiers).toContainEqual({
      property: { id: 'wdt:P648' },
      value: { type: 'value', content: work.key.split('/').at(-1) },
    });
    expect(firstB.exchanges.map((e) => e.bytes).join('')).not.toContain(aw.id);
    const oldRows = await f.candidates(be.id, relation);
    expect(oldRows).toHaveLength(1);
    const old = oldRows[0]!;
    expect(old.statement.value).toEqual({ type: 'somevalue' });
    expect(await f.candidates(be.id, relation, undefined, aw.id)).toEqual([]);
    const bBootstrap = f.bootstrap(b, edition.key);
    const contextResponse = await f.editor.http('/v1/contexts', { labels: { en: 'Named feed review' } });
    expect(contextResponse.status).toBe(201);
    const context = (contextResponse.body.context as { id: string }).id;
    await f.select(be.id, relation, old.id, context);

    const learned = await f.invoke(b, [edition, work]);
    completed(learned);
    const bw = f.claim(b, work.key);
    expect(bw.id).not.toBe(aw.id);
    const refreshed = await f.invoke(b, [edition, work]);
    completed(refreshed);
    const resolvedRows = await f.candidates(be.id, relation, context, bw.id);
    expect(resolvedRows).toHaveLength(1);
    const resolved = resolvedRows[0]!;
    expect(resolved.statement.value).toEqual({ type: 'value', content: bw.id });
    expect(resolved.id).not.toBe(old.id);
    const fresh = [...commands(learned.exchanges), ...commands(refreshed.exchanges)].find(
      (c): c is Propose =>
        c.op === 'propose' && c.source.external_id === edition.key && c.statement.property.id === relation,
    );
    expect(fresh).toBeDefined();
    expect(fresh!.key).not.toBe(oldProposal.key);
    expect(fresh!.source).toEqual(oldProposal.source);
    expect(fresh!.source.record_revision).toBe(String(edition.revision));
    expect(fresh!.source.converter_revision).toBe(converter_revision);
    const history = await f.candidates(be.id, relation, context);
    const retained = history.find((c) => c.id === old.id);
    expect(retained?.statement).toEqual(old.statement);
    expect(retained?.revision).toBe(old.revision);
    expect(retained?.retracted).not.toBeNull();
    const priorSelection = await f.original(b, `/v1/subjects/${be.id}?context=${context}`);
    expect(priorSelection.status).toBe(200);
    expect(selected(priorSelection.body, relation)).toContainEqual({ type: 'somevalue' });
    await f.select(be.id, relation, resolved.id, context, bw.id);
    const resolvedSelection = await f.original(b, `/v1/subjects/${be.id}?context=${context}`);
    expect(resolvedSelection.status).toBe(200);
    expect(selected(resolvedSelection.body, relation)).toContainEqual({ type: 'value', content: bw.id });
    expect(await f.candidates(be.id, relation, context, aw.id)).toEqual([]);
    const oldRevisions = await f.original(b, `/v1/subjects/${be.id}/revisions?limit=100`);
    expect(oldRevisions.status).toBe(200);
    expect(oldRevisions.body.revisions.some((r: { revision: number }) => r.revision === old.revision)).toBe(true);
    expect(f.bootstrap(b, edition.key)).toEqual(bBootstrap);
    expect(f.bootstrap(a, work.key)).toEqual(aBootstrap);
    expect(f.snapshot(a, [work.key, control.key])).toEqual(initialA);

    // Each actual reopen is a no-op, including both aliases' native work identity.
    const settledB = f.snapshot(b, [work.key, edition.key]);
    const receipts = await f.receipts();
    const candidatesB = await f.candidates(bw.id, 'schema:name');
    const repeatA = await f.invoke(a, [work, control]);
    completed(repeatA);
    expect(commands(repeatA.exchanges)).toEqual([]);
    const repeatB = await f.invoke(b, [edition, work]);
    completed(repeatB);
    expect(commands(repeatB.exchanges)).toEqual([]);
    expect(f.snapshot(a, [work.key, control.key])).toEqual(initialA);
    expect(f.snapshot(b, [work.key, edition.key])).toEqual(settledB);
    expect(await f.receipts()).toEqual(receipts);
    expect(await f.candidates(be.id, relation, context)).toEqual(history);
    expect(await f.candidates(bw.id, 'schema:name')).toEqual(candidatesB);

    // A real live guard excludes only its exact alias. No forged owner row or clock race.
    const owner = f.hold(a);
    const changedWork = { ...work, revision: work.revision + 1, title: 'Feed A revised title' };
    const beforeBusy = f.snapshot(a, [work.key, control.key]);
    const busy = await f.invoke(a, [changedWork, control]);
    expect(busy.code, busy.stderr).toBe(5);
    expect(busy.stderr).toContain('active import');
    expect(busy.consumed).toBe(0);
    expect(busy.exchanges).toEqual([]);
    expect(f.snapshot(a, [work.key, control.key])).toEqual(beforeBusy);
    expect(await f.receipts()).toEqual(receipts);
    const other = await f.invoke(b, [edition, work, control]);
    completed(other);
    expect(other.stdout).toContain('new=1');
    const bc = f.claim(b, control.key);
    expect(bc.id).not.toBe(ac.id);
    // The original ownership handle still works after B's CLI closed its connection.
    expect(owner.session.reopen(owner.ownership)).toBeNull();
    expect(f.snapshot(a, [work.key, control.key])).toEqual(beforeBusy);
    owner.release();
    const changed = await f.invoke(a, [changedWork, control]);
    completed(changed);
    expect(changed.stdout).toContain('changed=1');
    expect(f.claim(a, work.key).id).toBe(aw.id);
    const finalB = f.snapshot(b, [work.key, edition.key, control.key]);
    expect(finalB.source?.present_count).toBe(3);
    const bControlRows = await f.candidates(bc.id, 'schema:name');

    // A real disappearance retracts only A's returned candidates and advances only A's baseline.
    const vanished = await f.invoke(a, [changedWork]);
    completed(vanished);
    expect(vanished.stdout).toContain('vanished=1');
    const removed = commands(vanished.exchanges).filter((c) => c.op === 'retract');
    expect(removed.length).toBeGreaterThan(0);
    for (const command of removed) {
      expect(command.source.source).toBe(a);
      expect(command.source.external_id).toBe(control.key);
      expect(command.subject).toBe(ac.id);
    }
    expect(f.snapshot(a, [control.key]).source?.present_count).toBe(1);
    expect(f.snapshot(b, [work.key, edition.key, control.key])).toEqual(finalB);
    expect(await f.candidates(bc.id, 'schema:name')).toEqual(bControlRows);
    expect((await f.candidates(ac.id, 'schema:name')).every((c) => c.retracted !== null)).toBe(true);

    // Select B's actual supported contribution, then govern A's exact tuple through the API.
    await f.select(bw.id, 'schema:name', candidatesB[0]!.id, context);
    const supportedBefore = await f.original(b, `/v1/subjects/${bw.id}?context=${context}`);
    expect(supportedBefore.status).toBe(200);
    expect(selected(supportedBefore.body, 'schema:name')).toContainEqual({
      type: 'value',
      content: { language: 'und', text: work.title },
    });
    const fence = await f.editor.http('/v1/sourceFences:takedown', {
      source: a,
      externalId: work.key,
      fieldGroup: 'facts',
      reason: 'Controlled feed A withdrawal',
    });
    expect(fence.status, JSON.stringify(fence.body)).toBe(200);
    expect(fence.body.securityRevision).toMatch(/^[1-9][0-9]*$/);
    for (const [alias, fenced] of [
      [a, true],
      [b, false],
    ] as const) {
      const checked = await f.original(
        alias,
        `/v1/sourceFences:check?${new URLSearchParams({
          source: alias,
          externalId: work.key,
          fieldGroup: 'facts',
        })}`,
      );
      expect(checked.status).toBe(200);
      expect(checked.body).toEqual({ fenced, securityRevision: fenced ? fence.body.securityRevision : null });
    }
    const fencedA = await f.invoke(a, [{ ...changedWork, revision: work.revision + 2, title: 'Fenced A change' }]);
    completed(fencedA);
    expect(commands(fencedA.exchanges)).toEqual([]);
    expect(fencedA.exchanges.some((e) => JSON.parse(e.response).fenced === true)).toBe(true);
    expect(f.snapshot(b, [work.key, edition.key, control.key])).toEqual(finalB);
    const supportedAfter = await f.original(b, `/v1/subjects/${bw.id}?context=${context}`);
    expect(supportedAfter.status).toBe(200);
    expect(supportedAfter.body.subject).toEqual(supportedBefore.body.subject);
    const stable = await f.invoke(b, [edition, work, control]);
    completed(stable);
    expect(commands(stable.exchanges)).toEqual([]);
    expect(f.claim(a, work.key).id).toBe(aw.id);
    expect(f.claim(b, work.key).id).toBe(bw.id);
    expect(f.bootstrap(b, edition.key)).toEqual(bBootstrap);
    expect(f.bootstrap(a, work.key)).toEqual(aBootstrap);

    // Bibliographic citations retain Open Library identity under both aliases; facts carry no invented rights.
    for (const command of commands(f.exchanges)) {
      expect(command.source.converter_revision).toBe(converter_revision);
      if (command.op !== 'propose') continue;
      expect(command.source.field_group).toBe('facts');
      expect(command).not.toHaveProperty('rights');
      const parts = command.statement.references.flatMap((r) => r.parts);
      expect(parts).toContainEqual({
        property: { id: 'schema:url' },
        value: {
          type: 'value',
          content: `https://openlibrary.org${command.source.external_id}`,
        },
      });
      expect(parts).toContainEqual({
        property: { id: 'schema:version' },
        value: {
          type: 'value',
          content: command.source.record_revision,
        },
      });
    }
    const finalReceipts = await f.receipts();
    expect(finalReceipts.length).toBeGreaterThan(receipts.length);
    expect(f.authPaths.filter((p) => p === '/signin/key').length).toBeGreaterThan(0);
    console.log(
      'named feed native evidence',
      JSON.stringify({
        claims: { aw, ac, be, bw, bc },
        initialA,
        settledB,
        finalB,
        bootstraps: { a: aBootstrap, b: bBootstrap },
        receipts: finalReceipts,
        exchanges: f.exchanges.map(({ request: _request, ...e }) => e),
        publicResponses: f.publicResponses,
        bibliographies: f.bibliographies,
      }),
    );
  } finally {
    await f.close();
  }
}, 600_000);
