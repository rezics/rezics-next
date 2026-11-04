import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchStatement, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '../../../../packages/conversion/src/wikidata.ts';
import { birth, height, losslessRecord, claim } from '../../../importer/tests/wikidata-lossless-fixture.ts';
import type { Dump, Run, Exchange } from '../../../../specs/imports-api-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

type Candidate = { id: string; head: number | null; statement: BatchStatement & { id: string }; source: unknown };
const commands = (run: Run) => run.exchanges.flatMap((e) => (e.request.body as { commands: BatchCommand[] }).commands);
function complete(run: Run) {
  expect(run.outcome, JSON.stringify(run.exchanges)).toBe('complete');
  for (const exchange of run.exchanges) {
    expect(exchange.response.status).toBe(200);
    for (const result of (exchange.response.body as BatchWriteResult).results)
      expect(result.status, JSON.stringify(result)).toBeLessThan(400);
  }
}

test('ordinary Wikidata acquisition retains complete values through independent native review, refresh and replay fences', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 128 * 1024 });
  try {
    const editor = await openApiObserver(runtime);
    const record = losslessRecord();
    const neighbour = {
      ...losslessRecord(),
      id: 'Q123457',
      claims: { P31: [claim('P31', 'wikibase-item', { id: 'Q571', 'entity-type': 'item', 'numeric-id': 571 })] },
    };
    const dump = (revision = converter_revision): Dump => ({
      source: 'wikidata',
      snapshot: 'controlled-lossless',
      converterRevision: revision,
      bytes: new TextEncoder().encode([record, neighbour].map((r) => JSON.stringify(r)).join('\n') + '\n'),
    });
    const replayExchange = async (exchange: Exchange) => {
      const response = await runtime.replay(
        new Request(exchange.request.url, {
          method: exchange.request.method,
          headers: exchange.request.headers,
          body: exchange.request.serializedBody,
        }),
      );
      return { status: response.status, body: (await response.json()) as BatchWriteResult };
    };
    const first = await runtime.run(dump('wikidata-fixture-retained'));
    complete(first);
    const bound = runtime.importer.session.bindings.claim({ source: 'wikidata', external_id: record.id });
    if (bound?.state !== 'bound') throw new Error('Missing actual native subject binding');
    const id = bound.subject;
    const publicRead = async () => {
      const response = await runtime.request(`/v1/subjects/${id}?context=${GLOBAL_CONTEXT}`);
      expect(response.status).toBe(200);
      return (await response.json()) as {
        subject: { release: string; statements: Record<string, (BatchStatement & { id: string })[]> };
      };
    };
    const active = await runtime.request('/v1/definitions/active');
    expect(active.status).toBe(200);
    expect((await active.json()).digest).toBe(bundledDigest);
    expect((await publicRead()).subject.release).toBe(bundledDigest);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const page = async (property: string) => {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '100' })}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body as unknown as { candidates: Candidate[]; adoption: { head: number } | null };
    };
    const retained = new Map<string, Candidate[]>();
    for (const [property, contents] of [
      ['schema:birthDate', [birth]],
      ['schema:height', [height]],
      ['schema:deathDate', record.claims.P570.map((c) => c.mainsnak.datavalue.value)],
    ] as const) {
      const listing = await page(property);
      expect(listing.candidates.map((c) => c.statement.value)).toEqual(
        expect.arrayContaining(contents.map((content) => ({ type: 'value', content }))),
      );
      expect(listing.candidates).toHaveLength(contents.length);
      retained.set(property, listing.candidates);
      for (const candidate of listing.candidates) {
        expect(candidate.source).toMatchObject({
          source: 'wikidata',
          external_id: record.id,
          record_revision: '42',
          converter_revision: 'wikidata-fixture-retained',
        });
        const urls = candidate.statement.references.flatMap((r) => r.parts.map((p) => p.value));
        expect(urls).toContainEqual({ type: 'value', content: `https://www.wikidata.org/wiki/${record.id}?oldid=42` });
        expect(urls).toContainEqual({ type: 'value', content: 'https://example.org/source-measurement' });
        expect(
          (
            await editor.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, {
              context: GLOBAL_CONTEXT,
              expected_head: candidate.head,
            })
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await editor.http(`/v1/subjects/${id}:adopt`, {
            context: GLOBAL_CONTEXT,
            property,
            mode: 'replace',
            expected_head: listing.adoption?.head ?? null,
            selection: listing.candidates.map((c) => ({ candidate: c.id, rank: 'normal' })),
          })
        ).status,
      ).toBe(200);
    }
    expect((await page('schema:wordCount')).candidates).toEqual([]);
    const selected = (await publicRead()).subject.statements;
    for (const [property, candidates] of retained)
      expect(selected[property]).toEqual(expect.arrayContaining(candidates.map((c) => c.statement)));
    const receipts = await Promise.all(commands(first).map((c) => runtime.receipt(c.key)));
    expect(receipts.every(Boolean)).toBe(true);
    await runtime.restart();
    const unchanged = await runtime.run(dump('wikidata-fixture-retained'));
    complete(unchanged);
    expect(unchanged.exchanges).toEqual([]);
    const refresh = await runtime.run(dump());
    complete(refresh);
    expect(commands(refresh).some((c) => c.op === 'create')).toBe(false);
    expect(
      (await page('schema:height')).candidates.some((c) => JSON.stringify(c.source).includes(converter_revision)),
    ).toBe(true);
    expect((await publicRead()).subject.statements).toEqual(selected);
    record.claims.P2048 = [
      claim('P2048', 'quantity', { ...height, upperBound: '+9007199254740993.000000000000000003' }),
    ];
    record.lastrevid++;
    const lost = await runtime.run(dump(), { loseCommittedResponse: true });
    expect(lost.outcome).toBe('interrupted');
    await runtime.restart();
    const resumed = await runtime.run(dump());
    complete(resumed);
    const lostCommand = commands(lost)[0]!;
    expect(commands(resumed)).toContainEqual(lostCommand);
    expect(await runtime.receipt(lostCommand.key)).toBeString();
    const changed = (await page('schema:height')).candidates;
    expect(
      changed.some(
        (c) =>
          c.statement.value.type === 'value' &&
          JSON.stringify(c.statement.value.content).includes('000000000000000003'),
      ),
    ).toBe(true);
    expect((await publicRead()).subject.statements).toEqual(selected);
    const proposalExchange = refresh.exchanges.find((e) =>
      (e.request.body as { commands: BatchCommand[] }).commands.some((c) => c.op === 'propose'),
    )!;
    const proposal = commands(refresh).find((c) => c.op === 'propose' && c.statement.property.id === 'schema:height')!;
    // A source binding cannot be redirected to a different actual holder, even for an admitted value.
    const other = runtime.importer.session.bindings.claim({ source: 'wikidata', external_id: neighbour.id });
    if (other?.state !== 'bound' || proposal.op !== 'propose') throw new Error('Missing actual neighbouring binding');
    const mismatch: Exchange = {
      ...proposalExchange,
      request: {
        ...proposalExchange.request,
        body: { commands: [{ ...proposal, key: randomUUID(), subject: other.subject }] },
        serializedBody: JSON.stringify({
          commands: [{ ...proposal, key: 'controlled-binding-mismatch', subject: other.subject }],
        }),
      },
    };
    const rejected = await replayExchange(mismatch);
    expect(
      rejected.status === 200 ? (rejected.body as BatchWriteResult).results[0]!.status : rejected.status,
    ).toBeGreaterThanOrEqual(400);
    await runtime.identity.setBulkPermission(false);
    expect((await replayExchange(proposalExchange)).status).toBe(403);
    await runtime.identity.setBulkPermission(true);
    const fenced = await editor.http('/v1/sourceFences:takedown', {
      source: 'wikidata',
      externalId: record.id,
      fieldGroup: 'facts',
      reason: 'Controlled late fence',
    });
    expect(fenced.status).toBe(200);
    const replay = await replayExchange(proposalExchange);
    expect(replay.status).toBe(200);
    expect(await Promise.all(commands(first).map((c) => runtime.receipt(c.key)))).toEqual(receipts);
    expect((await publicRead()).subject.statements['schema:height'] ?? []).toEqual([]);
    const unknown = { ...proposal, key: randomUUID() };
    const unknownReplay = await replayExchange({
      ...proposalExchange,
      request: {
        ...proposalExchange.request,
        body: { commands: [unknown] },
        serializedBody: JSON.stringify({ commands: [unknown] }),
      },
    });
    expect(
      unknownReplay.status === 200 ? (unknownReplay.body as BatchWriteResult).results[0]!.status : unknownReplay.status,
    ).toBeGreaterThanOrEqual(400);
  } finally {
    await runtime.close();
  }
}, 1_800_000);
