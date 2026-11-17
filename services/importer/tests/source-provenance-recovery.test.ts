import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converter_revision } from '@rezics/conversion/bangumi';
import type { BatchCommand, BatchReference, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer } from '../src/importer.ts';
import type { Candidate } from '../src/record-bindings.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

test('source provenance refresh preserves acknowledged proposals through partial receipts and response loss on reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-provenance-recovery-'));
  type Result = BatchWriteResult['results'][number];
  const receipts = new Map<string, { bytes: string; result: Result }>();
  const requests: BatchWriteRequest[] = [];
  const effects: BatchCommand[] = [];
  let fault: 'partial' | 'lost' | null = null;
  const transport = {
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      requests.push(structuredClone(request));
      let refused = false;
      return {
        results: request.commands.map((command): Result => {
          const prior = receipts.get(command.key);
          if (prior) {
            expect(JSON.stringify(command)).toBe(prior.bytes);
            return prior.result;
          }
          if (fault === 'partial' && command.op === 'retract' && !refused) {
            refused = true;
            return {
              key: command.key,
              status: 409,
              problem: { type: 'conflict', title: 'Synthetic partial receipt', status: 409, retryable: false },
            };
          }
          const result: Result =
            command.op === 'create'
              ? { key: command.key, status: 201, value: { id: randomUUID(), revision: 1 } }
              : command.op === 'propose'
                ? { key: command.key, status: 201, value: { candidate: randomUUID(), revision: 1 } }
                : { key: command.key, status: 200, value: { revision: 1 } };
          effects.push(structuredClone(command));
          receipts.set(command.key, { bytes: JSON.stringify(command), result });
          return result;
        }),
      };
    },
  };
  const open = () =>
    new Importer({
      path: join(directory, 'state.sqlite'),
      transport,
      afterBulkSuccess() {
        if (fault === 'lost') throw new Error('Synthetic response loss before local acknowledgement');
      },
    });
  let importer = open();
  const owner = { source: 'bangumi', external_id: '1' };
  const registration = createSourceRegistration('bangumi');
  const source = (digest: string): BatchCommand['source'] => ({
    ...owner,
    record_revision: 'unversioned',
    converter_revision,
    digest,
    field_group: 'facts',
  });
  const references: BatchReference[] = [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://bgm.tv/subject/1' } }] },
  ];
  const expectFacts = (commands: BatchCommand[], date: string, digest: string, subject: string) => {
    const proposals = commands.filter((command) => command.op === 'propose');
    expect(proposals.map(({ key: _key, ...proposal }) => proposal)).toEqual(
      (
        [
          ['wdt:P5732', '1'],
          ['schema:name', { language: 'und', text: 'Same Book' }],
          [
            'schema:datePublished',
            {
              time: `+${date}T00:00:00Z`,
              precision: 11,
              calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
            },
          ],
        ] as const
      ).map(([id, content]) => ({
        op: 'propose',
        source: source(digest),
        subject,
        statement: { property: { id }, value: { type: 'value', content }, references },
      })),
    );
    return proposals;
  };
  const expectOwnedProposals = (candidates: Candidate[], proposals: ReturnType<typeof expectFacts>) => {
    expect(candidates.map(({ key }) => key).sort()).toEqual(proposals.map(({ key }) => key).sort());
    for (const proposal of proposals) {
      const candidate = candidates.find(({ key }) => key === proposal.key)!;
      expect(candidate.bytes).toBe(JSON.stringify({ commands: [proposal] }));
      expect(receipts.get(proposal.key)?.result).toEqual({
        key: proposal.key,
        status: 201,
        value: { candidate: candidate.candidate, revision: 1 },
      });
    }
  };
  const run = (date: string) =>
    importer.runDump(
      registration,
      (async function* () {
        yield new TextEncoder().encode(JSON.stringify({ id: 1, type: 1, name: 'Same Book', date }) + '\n');
      })(),
    );
  try {
    expect((await run('2000-01-01')).status).toBe('committed');
    const baseline = importer.session.store.source('bangumi');
    const baselineDigest = importer.session.store.key('bangumi', '1').baseline!.digest;
    const claim = importer.session.bindings.claim(owner);
    if (claim?.state !== 'bound') throw new Error('Missing original Bangumi subject binding');
    const initialReceipts = structuredClone([...receipts]);
    const old = importer.session.bindings.candidates(owner, 'facts', { limit: 100 });
    const originalProposals = expectFacts(effects, '2000-01-01', baselineDigest, claim.subject);
    expectOwnedProposals(old, originalProposals);
    const offset = requests.length;
    fault = 'partial';
    expect((await run('2001-01-01')).status).toBe('bulk-failed');
    expect(importer.session.store.source('bangumi')).toEqual(baseline);
    const plan = requests[offset]!;
    const refreshedDigest = plan.commands[0]!.source.digest;
    expect(refreshedDigest).not.toBe(baselineDigest);
    const proposals = expectFacts(plan.commands, '2001-01-01', refreshedDigest, claim.subject);
    const retractions = plan.commands.filter((command) => command.op === 'retract');
    expect(retractions.map(({ key: _key, ...retraction }) => retraction)).toEqual(
      old.map(({ candidate }) => ({
        op: 'retract',
        source: source(refreshedDigest),
        subject: claim.subject,
        candidate,
        references,
      })),
    );
    expect(plan.commands).toEqual([...retractions, ...proposals]);
    expect(new Set(plan.commands.map(({ key }) => key)).size).toBe(plan.commands.length);
    const originalKeys = new Set(initialReceipts.map(([key]) => key));
    expect(plan.commands.filter(({ key }) => originalKeys.has(key))).toEqual([]);
    const acknowledged = importer.session.bindings
      .candidates(owner, 'facts', { limit: 100 })
      .filter((candidate) => !old.some((prior) => prior.candidate === candidate.candidate));
    expectOwnedProposals(acknowledged, proposals);
    const runId = importer.session.store.activeRun('bangumi')!.id;
    await importer.close();
    importer = open();
    fault = 'lost';
    expect((await run('2001-01-01')).status).toBe('interrupted');
    expect(importer.session.store.source('bangumi')).toEqual(baseline);
    expect(importer.session.store.activeRun('bangumi')!.id).toBe(runId);
    const uncertain = requests.at(-1)!;
    expect(uncertain).toEqual(plan);
    await importer.close();
    importer = open();
    fault = null;
    expect((await run('2001-01-01')).status).toBe('committed');
    expect(requests.at(-1)).toEqual(uncertain);
    const current = importer.session.bindings.candidates(owner, 'facts', { limit: 100 });
    expect(current).toEqual(acknowledged);
    expect(importer.session.bindings.claim(owner)).toEqual(claim);
    expect(importer.session.store.key('bangumi', '1').baseline!.digest).toBe(refreshedDigest);
    expect(effects.filter((command) => command.op === 'propose')).toEqual([...originalProposals, ...proposals]);
    expect(
      effects
        .filter((command) => command.op === 'retract')
        .map(({ key }) => key)
        .sort(),
    ).toEqual(retractions.map(({ key }) => key).sort());
    expect(effects.filter((command) => command.op === 'create')).toHaveLength(1);
    for (const [key, receipt] of initialReceipts) expect(receipts.get(key)).toEqual(receipt);
    const count = requests.length;
    expect((await run('2001-01-01')).status).toBe('committed');
    expect(requests).toHaveLength(count);
  } finally {
    await importer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
