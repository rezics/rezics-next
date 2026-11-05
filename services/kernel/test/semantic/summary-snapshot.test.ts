import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryConfig } from 'pg';
import permissionRead from '../../src/access/permission-check.sql';
import { createKernel } from '../../src/http/kernel.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createSharedSummaryCoverFixture } from './support/shared-summary-cover-fixture.ts';

test('A default mounted summary batch spanning logical partitions uses one real physical database snapshot for representative facts labels resource authorization media and tuple fences while withheld identities remain null', async () => {
  // Reuse the native import/Auth/media fixture, including its registered re-encoder.
  // The read below mounts createKernel's own summary producer and native Access.
  const f = await createSharedSummaryCoverFixture();
  try {
    const { database, identity } = f.runtime;
    const homes = new Set<number>();
    let sourceSequence = 0;
    const source = () => {
      for (let probe = 0; probe < 64; probe++) {
        const value = f.source(`snapshot-${sourceSequence++}`);
        const home = partitionOf(tupleRoute(identity.routeKey, value.source, value.external_id));
        if (homes.has(home)) continue;
        homes.add(home);
        return value;
      }
      throw new Error('Could not allocate distinct native fixture homes');
    };
    const work = await f.create('schema:Book', { en: 'Before work', ja: 'Before work' }, source());
    const edition = await f.create('bf:Instance', { en: 'Before edition', ja: 'Before edition' }, source());
    const neighbour = await f.create('schema:Book', { en: 'Before neighbour', ja: 'Before neighbour' }, source());
    const hidden = await f.create('schema:Book', { en: 'Hidden title', ja: 'Hidden title' }, source());
    const coverSource = { ...source(), field_group: 'cover' as const };
    const media = await f.importCover(edition.id, coverSource);
    await f.adopt(edition.id, 'schema:image', media, coverSource);
    await f.adopt(work.id, 'rezics:representativeEdition', edition.id, work.source);
    await f.adopt(work.id, 'rezics:sameSetting', neighbour.id, work.source);
    await f.adopt(work.id, 'rezics:sameSetting', hidden.id, work.source);
    await f.converge([work.id, edition.id, neighbour.id, hidden.id]);
    await f.pauseProjection();
    await database.admin.query(
      "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
      [routeOf(hidden.id), hidden.id],
    );
    const missing = newId(routeOf(hidden.id)!);
    const before = await f.shared([work.id, neighbour.id, hidden.id, missing]);
    expect(before.get(work.id)?.cover?.media).toBe(media);
    expect(before.get(hidden.id)).toBeNull();
    expect(before.get(missing)).toBeNull();
    expect(partitionOf(routeOf(work.id)!)).not.toBe(partitionOf(routeOf(neighbour.id)!));
    expect(partitionOf(routeOf(work.id)!)).not.toBe(partitionOf(routeOf(edition.id)!));

    const kernel = createKernel({
      pool: database.pool,
      routeKey: identity.routeKey,
      tokens: identity.tokenKeys,
      requestDeadlineMs: 30_000,
    });
    type Kind = 'representative' | 'summary' | 'authorization' | 'media' | 'fence';
    type Transaction = { checkout: number; end?: string };
    type Sample = {
      kind: Kind;
      checkout: number;
      transaction: Transaction | undefined;
      backend: number;
      snapshot: string;
      isolation: string;
      readonly: string;
      resources: string[];
    };
    const scope = new AsyncLocalStorage<boolean>();
    const samples: Sample[] = [];
    const transactions: Transaction[] = [];
    const installed = new Map<PoolClient, PoolClient['query']>();
    let checkout = 0;
    const acquisitions = new WeakMap<PoolClient, number>();
    let wrote = false;
    const kindOf = (sql: string): Kind | undefined => {
      if (sql.includes('row_number() OVER (ORDER BY ordered.order_key')) return 'representative';
      if (sql.includes('Only the requested image, representative-edition and original-language slots'))
        return 'summary';
      if (sql.includes('one permission formula probes the bounded read batch')) return 'authorization';
      if (sql.includes('FROM content.media AS candidate')) return 'media';
      if (sql.includes('FROM content.source_fences AS stored')) return 'fence';
      return undefined;
    };
    // The writer commits after the final snapshot's representative probe, before
    // its labels, native resource formula, media and tuple probes. It never holds
    // or borrows the reader's client, and cannot serialize behind that read.
    const write = async () => {
      const client = await database.admin.connect();
      try {
        await client.query('BEGIN');
        for (const id of [work.id, neighbour.id]) {
          await client.query(
            `INSERT INTO semantic.fact(route,subject_id,slot_id,log_seq,operation,kind,language,body,recorded_transaction_id)
             SELECT route,subject_id,slot_id,log_seq+1,'assert',kind,language,to_jsonb('After writer'::text),recorded_transaction_id
             FROM semantic.current_term_fact WHERE route=$1 AND subject_id=$2 AND kind='label' AND language='en'
             ORDER BY log_seq DESC LIMIT 1`,
            [routeOf(id), id],
          );
        }
        await client.query(
          "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
          [routeOf(neighbour.id), neighbour.id],
        );
        await client.query(
          "UPDATE content.media SET average_color='#123456',security_revision=security_revision+1 WHERE route=$1 AND media_id=$2",
          [routeOf(media), media],
        );
        await client.query(
          `INSERT INTO content.source_fences(route,source,external_id,field_group,taken_down,security_revision,taken_down_at,takedown_id)
           VALUES($1,$2,$3,'cover',true,1,clock_timestamp(),$4)`,
          [
            tupleRoute(identity.routeKey, coverSource.source, coverSource.external_id),
            coverSource.source,
            coverSource.external_id,
            randomUUID(),
          ],
        );
        await client.query('COMMIT');
        wrote = true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const acquire = (client: PoolClient) => {
      acquisitions.set(client, ++checkout);
      if (installed.has(client)) return;
      const query = client.query.bind(client);
      installed.set(client, client.query);
      let transaction: Transaction | undefined;
      // Instrument native dispatch only; every result and permission decision is
      // produced by the installed code and PostgreSQL, never by this observer.
      client.query = ((...args: Parameters<PoolClient['query']>) => {
        const input = args[0] as string | QueryConfig;
        const sql = typeof input === 'string' ? input : input.text;
        const values = typeof input === 'string' ? args[1] : input.values;
        if (!scope.getStore() || args.some((arg) => typeof arg === 'function')) return query(...args);
        return (async () => {
          if (sql.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')) {
            transaction = { checkout: acquisitions.get(client)! };
            transactions.push(transaction);
          }
          const kind = kindOf(sql);
          if (kind) {
            const observed = await query<{ backend: number; snapshot: string; isolation: string; readonly: string }>(
              `SELECT pg_backend_pid() AS backend,pg_current_snapshot()::text AS snapshot,
                      current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly`,
            );
            const resources: unknown =
              kind === 'authorization' ? values?.[permissionRead.params.indexOf('resource_ids')] : undefined;
            samples.push({
              kind,
              transaction,
              checkout: acquisitions.get(client)!,
              ...observed.rows[0]!,
              resources: Array.isArray(resources) ? resources.filter((id): id is string => typeof id === 'string') : [],
            });
          }
          const result = await query(...args);
          const planned = transactions.some(
            (tx) =>
              tx.end === 'ROLLBACK' &&
              samples.some((sample) => sample.transaction === tx && sample.kind === 'representative'),
          );
          if (kind === 'representative' && planned && !wrote) await write();
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (transaction) transaction.end = sql;
            transaction = undefined;
          }
          return result;
        })();
      }) as PoolClient['query'];
    };
    database.pool.on('acquire', acquire);
    try {
      const path = `/v1/subjects/${work.id}/graph?${new URLSearchParams({ property: 'rezics:sameSetting', direction: 'out', depth: '1' })}`;
      const response = await scope.run(true, () => kernel.handle(new Request(`https://kernel.test${path}`)));
      const body = await response.json();
      expect({ status: response.status, ...(response.status === 200 ? {} : { body }) }).toEqual({ status: 200 });
      expect(wrote).toBe(true);
      expect(body.nodes.find((node: { id: string }) => node.id === work.id)?.summary).toEqual(before.get(work.id));
      expect(body.nodes.find((node: { id: string }) => node.id === neighbour.id)?.summary).toEqual(
        before.get(neighbour.id),
      );
      expect(body.nodes.some((node: { id: string }) => node.id === hidden.id)).toBe(false);
      const complete = transactions.filter((tx) =>
        samples.some((sample) => sample.transaction === tx && sample.kind === 'fence'),
      );
      expect(complete).toHaveLength(1);
      const final = complete[0]!;
      expect(final.end).toBe('COMMIT');
      const finalSamples = samples.filter((sample) => sample.transaction === final);
      expect(new Set(finalSamples.map((sample) => sample.kind))).toEqual(
        new Set(['representative', 'summary', 'authorization', 'media', 'fence']),
      );
      expect(new Set(finalSamples.map((sample) => sample.checkout))).toEqual(new Set([final.checkout]));
      expect(new Set(finalSamples.map((sample) => sample.backend)).size).toBe(1);
      expect(new Set(finalSamples.map((sample) => sample.snapshot)).size).toBe(1);
      const checked = new Set(
        finalSamples.filter((sample) => sample.kind === 'authorization').flatMap((s) => s.resources),
      );
      for (const id of [work.id, neighbour.id, edition.id]) expect(checked.has(id)).toBe(true);
      for (const sample of finalSamples) {
        expect(sample.isolation).toBe('repeatable read');
        expect(sample.readonly).toBe('on');
      }
      expect(
        samples.filter((sample) => sample.kind !== 'authorization').every((sample) => sample.transaction !== undefined),
      ).toBe(true);
    } finally {
      database.pool.off('acquire', acquire);
      for (const [client, query] of installed) client.query = query;
    }
    const after = await f.shared([work.id, neighbour.id, hidden.id, missing]);
    expect(after.get(work.id)?.label?.value).toBe('After writer');
    expect(after.get(work.id)?.cover).toBeNull();
    expect(after.get(neighbour.id)).toBeNull();
    expect(after.get(hidden.id)).toBeNull();
    expect(after.get(missing)).toBeNull();
  } finally {
    await f.close();
  }
}, 180_000);
