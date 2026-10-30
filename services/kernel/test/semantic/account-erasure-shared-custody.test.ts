import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { synchronizeAccountAgent } from '../../src/access/account-agent-effect.ts';
import { routeOf } from '../../src/route/route.ts';
import { accountErasureFixture } from './support/account-erasure-fixture.ts';
import { accountErasureWorker } from './support/account-erasure-worker.ts';
import { createBody } from '../zones/resource-fixture.ts';

test('actual Semantic and Zone minimization plus shared receiving custody permits one truthful participant acknowledgement', async () => {
  const f = await accountErasureFixture();
  let worker: Awaited<ReturnType<typeof accountErasureWorker>> | undefined;
  try {
    const author = await f.author();
    const acceptor = await f.author();
    await f.grant(GLOBAL_CONTEXT, acceptor, ['context:accept', 'context:adopt']);
    await f.grant(GLOBAL_CONTEXT, author, ['zone:create']);
    const created = await f.call(author, 'POST', '/v1/subjects', {
      type: 'schema:Person',
      labels: { en: 'Communal person' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const subject = created.body.subject.id as string;
    const publicValue = `https://example.test/public/${randomUUID()}`;
    const published = await f.call(author, 'POST', `/v1/subjects/${subject}/candidates`, {
      statement: {
        property: { id: 'schema:url' },
        value: { type: 'value', content: publicValue },
        references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: publicValue } }] }],
      },
    });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const publicCandidate = published.body.candidate as string;
    const accepted = await f.call(acceptor, 'POST', `/v1/subjects/${subject}/candidates/${publicCandidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const adopted = await f.call(acceptor, 'POST', `/v1/subjects/${subject}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:url',
      mode: 'replace',
      selection: [{ candidate: publicCandidate, rank: 'normal' }],
      expected_head: null,
    });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    const privateValue = accountAgentId(author.accountId);
    const privateProposal = await f.call(author, 'POST', `/v1/subjects/${subject}/candidates`, {
      statement: { property: { id: 'rezics:penNameOf' }, value: { type: 'value', content: privateValue } },
    });
    expect(privateProposal.status, JSON.stringify(privateProposal.body)).toBe(201);
    const privateCandidate = privateProposal.body.candidate as string;
    const source = await f.db.admin.query<{ recorded_transaction_id: string }>(
      `SELECT r.recorded_transaction_id FROM semantic.candidate c
      JOIN semantic.revision r USING(route,subject_id,revision)
      WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$3`,
      [routeOf(subject), subject, privateCandidate],
    );
    expect(source.rows).toHaveLength(1);
    const publicSource = await f.db.admin.query<{ recorded_transaction_id: string }>(
      `SELECT r.recorded_transaction_id FROM semantic.candidate c
      JOIN semantic.revision r USING(route,subject_id,revision)
      WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=$3`,
      [routeOf(subject), subject, publicCandidate],
    );
    expect(publicSource.rows).toHaveLength(1);
    const partition = Math.floor(routeOf(subject)! / 16);
    const privateEvents = await f.db.admin.query<{ position: string; event_seq: number }>(
      `SELECT o.position::text,o.event_seq FROM editorial.write_basis b JOIN core.outbox o USING(partition_no,position)
      WHERE b.partition_no=$1 AND b.transaction_id=$2 ORDER BY o.event_seq LIMIT 100`,
      [partition, source.rows[0]!.recorded_transaction_id],
    );
    expect(privateEvents.rows.length).toBeGreaterThan(0);
    const zones: string[] = [];
    for (const archived of [false, true]) {
      const input = createBody();
      input.configuration.scope = [];
      input.configuration.labels.en = `Private owner payload ${randomUUID()}`;
      const zone = await f.call(author, 'POST', '/v1/zones', input);
      expect(zone.status, JSON.stringify(zone.body)).toBe(201);
      zones.push(zone.body.zone.id);
      const readable = await f.call(author, 'GET', `/v1/zones/${zone.body.zone.id}/configuration`);
      expect(readable.status, JSON.stringify(readable.body)).toBe(200);
      expect(readable.body.configuration).toEqual(input.configuration);
      if (archived) {
        const removed = await f.call(author, 'DELETE', `/v1/zones/${zone.body.zone.id}`, undefined, {
          'if-match': JSON.stringify(zone.body.zone.revision),
        });
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      }
    }
    const before = await f.call(undefined, 'GET', `/v1/subjects/${subject}`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(JSON.stringify(before.body)).toContain(publicValue);
    const deletion = await f.tombstone(author);
    // The supplied default worker must perform every mutation and the separate native ACK.
    // No test-generated acknowledgement, custody receipt or progress row can satisfy this case.
    worker = await accountErasureWorker(f.db.url);
    const deadline = Date.now() + 180_000;
    let status = await f.status(author.accountId);
    while (status?.participants.semantic?.outcome === 'pending' && Date.now() < deadline) {
      await Bun.sleep(100);
      status = await f.status(author.accountId);
    }
    expect(status?.at).toBe(deletion.result.at);
    expect(status?.participants.semantic).toEqual({ outcome: 'erased', retained: [] });
    expect(status?.participants).not.toHaveProperty('zones');
    const privateRow = await f.db.admin.query(
      `SELECT statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
      [routeOf(subject), subject, privateCandidate],
    );
    expect(JSON.stringify(privateRow.rows)).not.toContain(privateValue);
    const attribution = await f.db.admin.query(
      `SELECT principal_id,requested_by FROM editorial.write_basis
      WHERE partition_no=$1 AND transaction_id=ANY($2::uuid[])`,
      [partition, [source.rows[0]!.recorded_transaction_id, publicSource.rows[0]!.recorded_transaction_id]],
    );
    expect(JSON.stringify(attribution.rows)).not.toContain(author.accountId);
    const events = await f.db.admin.query(
      `SELECT data FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=ANY($3::integer[])`,
      [partition, privateEvents.rows[0]!.position, privateEvents.rows.map(({ event_seq }) => event_seq)],
    );
    expect(events.rows).toHaveLength(privateEvents.rows.length);
    for (const row of events.rows) {
      expect(JSON.stringify(row.data)).not.toContain(privateValue);
    }
    for (const zone of zones) {
      const row = await f.db.admin.query(
        `SELECT configuration,mounts,owner_id,state,restore_until FROM zones.zone WHERE route=$1 AND zone_id=$2`,
        [routeOf(zone), zone],
      );
      expect(row.rows).toEqual([
        { configuration: null, mounts: [], owner_id: null, state: 'purged', restore_until: null },
      ]);
    }
    const retained = await f.call(undefined, 'GET', `/v1/subjects/${subject}`);
    expect(retained.status, JSON.stringify(retained.body)).toBe(200);
    expect(JSON.stringify(retained.body)).toContain(publicValue);
    expect(JSON.stringify(retained.body)).not.toContain(author.handle);
    const ack = () =>
      f.db.admin.query(
        `SELECT xmin::text AS commit, outcome, retained FROM access.erasure_acknowledgement
      WHERE route=$1 AND account_id=$2 AND participant='semantic'`,
        [routeOf(author.accountId), author.accountId],
      );
    const original = await ack();
    expect(original.rows).toHaveLength(1);
    await worker.crash();
    worker = undefined;
    await synchronizeAccountAgent(f.db.pool, author.accountId);
    await synchronizeAccountAgent(f.db.pool, author.accountId);
    worker = await accountErasureWorker(f.db.url);
    expect((await ack()).rows).toEqual(original.rows);
    const late = await f.call(author, 'POST', '/v1/subjects', {
      type: 'schema:Person',
      labels: { en: 'Late private producer' },
    });
    expect([401, 403]).toContain(late.status);
    expect((await ack()).rows).toEqual(original.rows);
  } finally {
    try {
      await worker?.crash();
    } finally {
      await f.close();
    }
  }
}, 420_000);
