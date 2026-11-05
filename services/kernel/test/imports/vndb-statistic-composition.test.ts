import { expect, test } from 'bun:test';
import vndb from '../../../../specs/fixtures/imports/vndb/record.json';
import { GLOBAL } from '../../../../specs/imports-identity-driver.ts';
import { VNDB_IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { withConnection } from '../../src/database/pool.ts';
import { accessCheck } from '../../src/request/access.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiRuntime } from './api-runtime.ts';
import { createImportIdentityDriver } from './identity-driver.ts';
import { identitySupport } from './identity-fixture.ts';

test('default identity rejects statistic grant changes without widening its six scopes', async () => {
  const driver = createImportIdentityDriver();
  try {
    const identity = await driver.open({ clock: () => new Date() });
    expect(identity.client.scopes).toHaveLength(6);
    expect(identity.client.scopes).not.toContain('source_statistic:write');
    await expect(identitySupport(identity).setStatisticGrant(true)).rejects.toThrow('Explicit VNDB');
    await expect(identitySupport(identity).setStatisticGrant(false)).rejects.toThrow('Explicit VNDB');
  } finally {
    await driver.close();
  }
}, 120_000);

test('explicit VNDB runtime uses seven Auth scopes, public statistic writes and current Global grants', async () => {
  const runtime = await openApiRuntime({
    batchRecords: 8,
    maxFields: 64,
    maxRecordBytes: 65536,
    sourceStatistics: 'vndb',
  });
  try {
    const { identity, database } = runtime;
    const support = identitySupport(identity);
    const realAccess = identity.access;
    const originalBearer = runtime.bulk.bearer;
    const context = () => ({ pool: database.pool, deadline: Date.now() + 10_000 });
    const actor = await realAccess.authenticate(originalBearer, context());
    expect(actor.kind).toBe('account');
    expect(actor.accountId).toBe(identity.bulk.accountId);
    expect([...identity.client.scopes].sort()).toEqual([...VNDB_IMPORTER_SCOPES].sort());
    expect([...actor.scopes].sort()).toEqual([...VNDB_IMPORTER_SCOPES].sort());
    async function permits(bearer: string, action = 'source_statistic:write') {
      const ctx = context();
      const actor = await realAccess.authenticate(bearer, ctx);
      const check = await accessCheck(realAccess, actor, action, GLOBAL, ctx);
      return withConnection(database.pool, (client) => check(client));
    }
    expect(await permits(originalBearer)).toBe(true);
    expect(
      support.grantLocators.some(
        (grant) =>
          grant.resource.id === GLOBAL.id &&
          grant.resource.route === GLOBAL.route &&
          grant.subject?.kind === 'account' &&
          grant.subject.id === actor.accountId &&
          grant.actions.includes('source_statistic:write'),
      ),
    ).toBe(true);

    const record = structuredClone(vndb);
    record.vn.c_average = 735;
    record.vn.c_votecount = 20;
    const registration = createSourceRegistration('vndb');
    const input = { external_id: record.vn.id, record_revision: String(record.entry_meta.revision), record };
    const conversion = registration.convert(input, { source: registration.source });
    expect(conversion.proposals).toHaveLength(1);
    expect(conversion.proposals[0]!.op).toBe('create');
    const created = await runtime.importTransport.batch({ commands: [...conversion.proposals] });
    expect(created.results[0]!.status).toBeLessThan(300);
    const first = created.results[0]!;
    const subjectId = 'value' in first && 'id' in first.value ? first.value.id : undefined;
    expect(subjectId).toBeString();
    if (typeof subjectId !== 'string') throw new Error('Public create did not return a subject UUID');
    const path = `/v1/subjects/${subjectId}/source-statistics/vndb`;
    const route = routeOf(subjectId)!;
    const partition = partitionOf(route);

    // Exercise the Importer's configured callback on one native grouped record.
    // This deliberately makes no assertion about the separate portable archive suite.
    const run = await runtime.importer.runRecords(
      registration,
      (async function* () {
        yield { source: 'vndb' as const, key: record.vn.id, revision: input.record_revision, payload: record };
      })(),
      { maxRecordBytes: 65536, collectionLimit: 10000 },
    );
    expect(run.status).toBe('committed');
    const puts = runtime.captures.filter((capture) => capture.request.method === 'PUT');
    expect(puts).toHaveLength(1);
    const put = puts[0]!;
    expect(new URL(put.request.url).pathname).toBe(path);
    expect(put.request.headers.get('authorization')).toBe(`Bearer ${originalBearer}`);
    expect(put.response.status).toBe(200);
    const expected = {
      source: 'vndb',
      sourceRecordId: 'v123',
      scale: { min: 1, max: 10 },
      mean: 7.35,
      count: 20,
      asOf: '2026-10-25',
      licence: 'ODbL-1.0',
      attribution: 'VNDB',
    };
    expect(await put.response.clone().json()).toEqual(expected);
    const currentRequest = new Request(new URL(`/v1/subjects/${subjectId}/source-statistics`, put.request.url));
    expect(currentRequest.headers.get('authorization')).toBeNull();
    const current = await runtime.replay(currentRequest);
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual([expected]);
    const key = JSON.parse(put.request.headers.get('idempotency-key')!) as string;
    const replay = (bearer = originalBearer) =>
      runtime.replay(
        new Request(put.request.url, {
          method: 'PUT',
          headers: { ...Object.fromEntries(put.request.headers), authorization: `Bearer ${bearer}` },
          body: put.body,
        }),
      );

    // Exact subject/source, account and receipt anchors; no catalogue/history scans.
    async function observe() {
      const statistic = await database.admin.query(
        'SELECT * FROM rating.source_statistic WHERE route=$1 AND subject_id=$2 AND source=$3',
        [route, subjectId, 'vndb'],
      );
      const receipt = await database.admin.query(
        `SELECT * FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
         AND command_kind='rating.source_statistic.write' AND idempotency_key=$3`,
        [partition, actor.accountId, key],
      );
      const events = receipt.rows.length
        ? await database.admin.query(
            'SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq',
            [partition, receipt.rows[0]!.position],
          )
        : { rows: [] };
      const votes = await database.admin.query(
        'SELECT * FROM rating.vote WHERE route=$1 AND voter_id=$2 AND target_id=$3',
        [routeOf(actor.accountId), actor.accountId, subjectId],
      );
      const position = await database.admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [
        partition,
      ]);
      return {
        statistic: statistic.rows,
        receipt: receipt.rows,
        events: events.rows,
        votes: votes.rows,
        position: position.rows,
      };
    }
    const committed = await observe();
    expect(committed.statistic).toHaveLength(1);
    expect(committed.receipt).toHaveLength(1);
    expect(committed.events).toHaveLength(1);
    expect(committed.events[0]).toMatchObject({
      type: 'com.rezics.rating.source_statistic.changed.v1',
      subject: subjectId,
    });
    expect(committed.statistic[0]!.transaction_id).toBe(committed.receipt[0]!.transaction_id);
    expect(committed.votes).toEqual([]);
    async function denied(response: Response) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        type: 'https://rezics.com/problems/forbidden',
        title: 'Forbidden',
        status: 403,
        code: 'forbidden',
        retryable: false,
        effect_status: 'not_applied',
        request_id: expect.any(String),
      });
    }
    const limited = await support.issue(
      actor.accountId,
      VNDB_IMPORTER_SCOPES.filter((scope) => scope !== 'source_statistic:write'),
    );
    expect(await permits(limited.bearer)).toBe(false);
    await denied(await replay(limited.bearer));
    expect(await observe()).toEqual(committed);

    await support.setStatisticGrant(false);
    const revoked = await observe();
    expect(await permits(originalBearer)).toBe(false);
    expect(await permits(originalBearer, 'subject:create')).toBe(true);
    expect(await permits(originalBearer, 'subject:batch_write')).toBe(true);
    await denied(await replay());
    expect(await observe()).toEqual(revoked);
    await support.setStatisticGrant(true);
    expect(await permits(originalBearer)).toBe(true);
    const restored = await observe();
    expect((await replay()).status).toBe(200);
    expect(await observe()).toEqual(restored);
    expect(runtime.bulk.bearer).toBe(originalBearer);
  } finally {
    await runtime.close();
  }
}, 240_000);
