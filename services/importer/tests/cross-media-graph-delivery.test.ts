import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { type BatchWriteRequest } from '@rezics/definitions/bulk';
import { CrossMediaGraph, graphEdgeCommandKey, type GraphEdgeDraft } from '../src/cross-media-bindings.ts';
import { createImportTransport } from '../src/import-client.ts';
import {
  formatSeedFailure,
  remainingRequestFromPreparedCommand,
  seedBatchRemainingRequest,
} from '../src/seed-remaining-request.ts';
import { captureShowcaseCommands, ShowcaseJournal } from '../src/showcase-journal.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('seed graph failure keeps the refused Episode receipt ahead of another prepared command', async () => {
  const db = new Database(':memory:');
  const journal = new ShowcaseJournal(':memory:');
  try {
    const graph = new CrossMediaGraph(db);
    const transport = createImportTransport({
      origin: 'https://kernel.test',
      tokenProvider: async () => 'fixture-token',
      fetch: (async (request: Request) => {
        expect(request.headers.get('authorization')).toBe('Bearer fixture-token');
        const {
          commands: [command],
        } = (await request.json()) as BatchWriteRequest;
        expect(command).toMatchObject({
          op: 'propose',
          source: { external_id: 'episode:150205', converter_revision: 'cross-media-entities@1' },
          statement: { property: { id: 'schema:isPartOf' } },
        });
        journal.prepareCommand({
          ...command!,
          key: '000:other',
          source: { ...command!.source, external_id: 'episode:150204' },
        });
        return Response.json({
          results: [
            {
              key: command!.key,
              status: 503,
              problem: {
                type: 'https://rezics.com/problems/transaction_retry_exhausted',
                title: 'Transaction retry exhausted',
                status: 503,
                code: 'transaction_retry_exhausted',
                retryable: true,
                phase: 'transaction_body',
                detail: 'private reply',
              },
            },
          ],
        });
      }) as typeof fetch,
      maxAttempts: 1,
    });
    const port = captureShowcaseCommands(transport, journal);
    graph.remember([
      {
        source: 'bangumi',
        alias: 'bangumi_cross_media',
        table: 'episode',
        holder: 'episode:150205',
        target: '233',
        property: 'schema:isPartOf',
        url: 'https://bgm.tv/ep/150205',
        membership: 'referenced',
        record: { id: 150205, subject_id: 233, name: 'private provider title' },
        fields: ['id', 'subject_id'],
        qualifiers: [{ property: 'schema:position', content: 2 }],
      },
    ]);
    let failure: unknown;
    try {
      await graph.deliver({
        claim: ({ external_id }) => ({ state: 'bound', subject: id(external_id === '233' ? 1 : 2) }),
        nativeType: () => undefined,
        currentRelationEndpoint: async () => 'current',
        fence: async () => ({ fenced: false, securityRevision: null }),
        batch: port.batch,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const prepared = journal.preparedCommands();
    expect(prepared.map(({ command }) => command.source.external_id)).toEqual(['episode:150204', 'episode:150205']);
    const line = formatSeedFailure(failure, remainingRequestFromPreparedCommand(prepared[0]!.command));
    expect(line).toContain('status=503');
    expect(line).toContain('problem=transaction_retry_exhausted');
    expect(line).toContain('episode:150205');
    expect(line).toContain('transition=batch-receipt reason=command-refused');
    expect(line).toContain('transaction_phase=transaction_body');
    expect(line).not.toMatch(/episode:150204|private|fixture-token/);
  } finally {
    journal.close();
    db.close();
  }
});

test('graph delivery keeps sealed order and skips acknowledged proposal pages on reopen', async () => {
  const db = new Database(':memory:');
  try {
    const graph = new CrossMediaGraph(db);
    const drafts: GraphEdgeDraft[] = Array.from({ length: 66 }, (_, i) => ({
      source: 'vndb',
      alias: 'vndb_cross_media',
      table: 'releases_vn',
      holder: `r${i + 100}`,
      target: 'v1',
      property: 'schema:exampleOfWork',
      url: `https://vndb.org/r${i + 100}`,
      membership: 'referenced',
      record: { id: `r${i + 100}`, vid: 'v1', rtype: 'complete' },
      fields: ['releases_vn.id'],
    }));
    graph.remember(drafts);
    const keys = graph.planned().map(graphEdgeCommandKey);
    const pages: string[][] = [];
    let interrupted = true;
    const deadline = new Error('fixture transport interrupted');
    const deliver = () =>
      graph.deliver({
        claim: ({ external_id }) => ({ state: 'bound', subject: id(Number(external_id.slice(1))) }),
        nativeType: () => undefined,
        currentRelationEndpoint: async () => 'current',
        fence: async () => ({ fenced: false, securityRevision: null }),
        async batch({ commands }) {
          pages.push(commands.map(({ key }) => key));
          if (interrupted && pages.length === 2) throw deadline;
          return {
            results: commands.map(({ key }) => ({
              key,
              status: 201,
              value: { candidate: id(keys.indexOf(key) + 200), revision: 1 },
            })),
          };
        },
      });
    await expect(deliver()).rejects.toBe(deadline);
    expect(seedBatchRemainingRequest(deadline)).toMatchObject({ transition: 'batch-send', reason: 'request-failed' });
    expect(seedBatchRemainingRequest(deadline)?.externalId).toBeUndefined();
    expect(pages).toEqual([keys.slice(0, 32), keys.slice(32, 64)]);
    interrupted = false;
    await deliver();
    expect(pages.slice(2)).toEqual([keys.slice(32, 64), keys.slice(64)]);
    expect(graph.planned()).toEqual([]);
  } finally {
    db.close();
  }
});
