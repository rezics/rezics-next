import { expect, test } from 'bun:test';
import { runCommand } from '../../src/command/command.ts';
import { projectBatch, type CloudEvent } from '../../src/events/log.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  deliverCanonicalGenerationEvent,
  readCanonicalGenerationDeliveryPage,
  resumeCanonicalGenerationDelivery,
} from '../../src/semantic/canonical-generation-delivery.ts';
import { CANONICAL_GENERATION_COMMITTED, CANONICAL_GENERATION_CONTINUATION } from '../../src/semantic/events.ts';
import { fixture, readContext } from './support/public-filter-source.ts';

test('canonical delivery recovers lost empty-home notifications and never acknowledges rollback or a later generation', async () => {
  const f = await fixture();
  try {
    const subject = await f.create();
    const route = routeOf(subject)!;
    const partition = partitionOf(route);
    const pool = f.db.openPool({ max: 1 });
    const request = (home: number) => ({ after: home === 0 ? null : home - 1, limit: 1 });
    const counter = async (home: number) => (await f.db.admin.query<{
      generation: string;
      delivered: string;
      count: string;
    }>(
      `SELECT canonical_generation::text AS generation,canonical_delivered_generation::text AS delivered,
              canonical_count::text AS count FROM semantic.partition_subjects WHERE partition_no=$1`,
      [home],
    )).rows[0]!;
    const pending = (home: number) => readCanonicalGenerationDeliveryPage(pool, request(home), readContext());
    const notifications = async (home: number) => {
      const events: CloudEvent[] = [];
      // Read the actual kernel envelope; never construct a source identity from an affected ID.
      for (let page = 0; page < 10; page++) {
        const result = await projectBatch(pool, {
          partition: home,
          consumer: 'canonical_generation_delivery_test',
          apply: async (envelopes) => {
            events.push(...envelopes.flatMap((envelope) => envelope.events));
          },
        });
        expect(result.status).toBe('read');
        if (result.status !== 'read') throw new Error('Native canonical test log stopped');
        if (result.envelopes === 0) return events;
      }
      throw new Error('Canonical fixture exceeded its native event bound');
    };
    const committed = (events: CloudEvent[]) => {
      const event = events.findLast((entry) => entry.type === CANONICAL_GENERATION_COMMITTED);
      expect(event).toBeDefined();
      return event!;
    };

    const initial = await counter(partition);
    await expect(runCommand(pool, { partition }, async (tx) => {
      await tx.query('UPDATE semantic.subject SET visibility=$3 WHERE route=$1 AND subject_id=$2', [
        route, subject, 'hidden',
      ]);
      throw new Error('abort canonical change');
    })).rejects.toThrow('abort canonical change');
    expect(await counter(partition)).toEqual(initial);
    expect((await pending(partition)).homes[0]).toEqual({ partition, generation: initial.generation });

    await resumeCanonicalGenerationDelivery(pool, request(partition));
    const firstEvents = await notifications(partition);
    const first = committed(firstEvents);
    expect(first.data).toEqual({ partition, generation: initial.generation });
    expect(first.source).toMatch(new RegExp(`^urn:rezics:log:${partition}\\.[1-9][0-9]*$`));
    if (partition < 4095) {
      expect(firstEvents.find((event) => event.type === CANONICAL_GENERATION_CONTINUATION)?.data)
        .toEqual({ after: partition, limit: 1 });
    }
    await expect(deliverCanonicalGenerationEvent(pool, first, async () => {
      throw new Error('receiver unavailable');
    })).rejects.toThrow('receiver unavailable');
    expect(await counter(partition)).toEqual(initial);

    await deliverCanonicalGenerationEvent(pool, first, async (generation, envelope) => {
      expect(generation).toEqual(first.data);
      expect(envelope).toBe(first);
      // This single-connection pool must be available to WorkClient/foreign work. A later native
      // transition races receipt acknowledgement, and must remain outstanding after it commits.
      await runCommand(pool, { partition }, async (tx) => {
        const row = (await tx.query<{ revision: string }>(
          `UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1
           WHERE route=$1 AND subject_id=$2 RETURNING security_revision::text AS revision`,
          [route, subject],
        )).rows[0]!;
        return {
          value: null,
          events: [{
            type: 'com.rezics.subject.visibility_changed.v1',
            subject,
            data: { id: subject, visibility: 'hidden', security_revision: Number(row.revision) },
          }],
        };
      });
    });
    const later = await counter(partition);
    expect(later.delivered).toBe(initial.generation);
    expect(BigInt(later.generation)).toBeGreaterThan(BigInt(initial.generation));
    expect((await pending(partition)).homes[0]).toEqual({ partition, generation: later.generation });
    await resumeCanonicalGenerationDelivery(pool, request(partition));
    const newer = committed(await notifications(partition));
    expect(newer.data).toEqual({ partition, generation: later.generation });
    await deliverCanonicalGenerationEvent(pool, newer, async () => {});
    await deliverCanonicalGenerationEvent(pool, first, async () => {});
    expect((await counter(partition)).delivered).toBe(later.generation);

    // Fixture for an empty retained home: the Subject deletion trigger preserves this counter.
    // No Subject/scored row may be needed to discover and deliver its terminal generation.
    const emptyHome = (await f.db.admin.query<{ partition: number }>(
      `SELECT home.partition_no AS partition FROM core.partition AS home
       WHERE home.write_state='active' AND NOT EXISTS (
         SELECT 1 FROM semantic.partition_subjects AS population WHERE population.partition_no=home.partition_no
       ) ORDER BY home.partition_no LIMIT 1`,
    )).rows[0]!.partition;
    await f.db.admin.query(
      'INSERT INTO semantic.partition_subjects(partition_no,canonical_count) VALUES($1,0)',
      [emptyHome],
    );
    expect((await counter(emptyHome)).count).toBe('0');
    await resumeCanonicalGenerationDelivery(pool, request(emptyHome));
    const lost = committed(await notifications(emptyHome));
    // Simulate losing the delivery after the source commit. No retained cursor or in-memory
    // notification is needed by startup; the same counter produces a new real native envelope.
    await resumeCanonicalGenerationDelivery(pool, request(emptyHome));
    const recovered = committed(await notifications(emptyHome));
    expect(recovered.id).not.toBe(lost.id);
    expect(recovered.data).toEqual(lost.data);
    await deliverCanonicalGenerationEvent(pool, recovered, async (generation) => {
      expect((await pool.query('SELECT 1 FROM semantic.subject WHERE route/16=$1 LIMIT 1', [generation.partition])).rows)
        .toEqual([]);
    });
    expect((await counter(emptyHome)).delivered).toBe((await counter(emptyHome)).generation);
    expect((await pending(emptyHome)).homes.some((home) => home.partition === emptyHome)).toBe(false);
  } finally {
    await f.close();
  }
});
