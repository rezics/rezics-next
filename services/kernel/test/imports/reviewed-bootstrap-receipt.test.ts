import { expect, test } from 'bun:test';
import {
  reviewedCatalogueEnvelope,
  reviewedCatalogueKey,
  reviewedCatalogueMetadata,
  reviewedCatalogueSeedOwner,
} from '../../../importer/src/reviewed-catalogue-contract.ts';
import { releasedReviewedVocabulary } from '../../../importer/src/reviewed-vocabulary-port.ts';
import { withQueryAccounting } from '../../src/database/pool.ts';
import { openApiRuntime } from './api-runtime.ts';

test('released episode type bootstrap settles a lost COMMIT reply from its original native creation receipt', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  const ack = Promise.withResolvers<void>();
  try {
    const vocabulary = releasedReviewedVocabulary();
    const seed = vocabulary.inventory.find((entry) => entry.key === 'bangumi-episode-type-4')!;
    const owner = reviewedCatalogueSeedOwner(seed);
    const metadata = reviewedCatalogueMetadata(seed);
    const port = runtime.importTransport;
    await port.setSourceRecordMetadata({ command: metadata.command, idempotencyKey: metadata.key });
    const command = {
      op: 'create' as const,
      source: reviewedCatalogueEnvelope(seed, vocabulary.revision),
      key: reviewedCatalogueKey(owner, 'bootstrap'),
      subject: { type: seed.type, labels: seed.labels },
    };
    const body = { commands: [command] };
    let inserts = 0;
    let lost = false;
    const first = await withQueryAccounting(
      {
        connection: (dispatch) => dispatch(),
        async query(sql, operands, dispatch) {
          const result = await dispatch();
          if (sql.includes('INSERT INTO semantic.external_claim') && operands.includes(owner.external_id)) inserts++;
          if (sql === 'COMMIT' && inserts && !lost) {
            lost = true;
            await ack.promise;
          }
          return result;
        },
      },
      () => port.batch(body),
    );
    const sends = runtime.captures.filter(({ request }) => new URL(request.url).pathname === '/v1/subjects:batchWrite');
    expect(lost).toBe(true);
    expect(inserts).toBe(1);
    const claims = await runtime.database.admin.query(
      `SELECT c.subject_id, r.transaction_id FROM semantic.external_claim c
       JOIN core.receipt r ON r.partition_no=c.route/16 AND r.transaction_id=c.recorded_transaction_id
       WHERE c.source=$1 AND c.external_id=$2 AND r.command_kind='subject.batch_create'`,
      [owner.source, owner.external_id],
    );
    expect(claims.rows).toHaveLength(1);
    expect(first.results).toEqual([
      { key: command.key, status: 201, value: { id: claims.rows[0].subject_id, revision: 1 } },
    ]);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.body).toBe(sends[0]!.body);
    expect(
      runtime.httpEvents.find((event) => event.commandKeys.includes(command.key))?.commandProblems?.[0],
    ).toMatchObject({
      status: 503,
      problem: { code: 'deadline_exceeded', effect_status: 'unknown', retryable: true },
    });
  } finally {
    ack.resolve();
    await runtime.close();
  }
}, 180_000);
