import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

test('a scalar writer receives 202 after a committed effect with unavailable Access settlement, then replays it once', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `scalar-settlement-${randomUUID()}`));
  const fault = `scalar_settlement_${randomUUID().replaceAll('-', '')}`;
  let installed = false;
  try {
    const created = await f.json<{ work: string; workRevision: string }>(await f.call('POST', '/v1/works',
      await f.authoredBody({ profile: 'metadata-only-v1', language: 'en', title: 'Scalar settlement', actingSubject: f.actor })), 201);
    await f.grant(`work:edit:${created.work}`, 'work.edit');
    await f.grant(`work:read:${created.work}`, 'work.read');
    const path = `/v1/works/${shortId(created.work)}/scalar-value`;
    const body = { profile: 'work-scalar-state-v1', expectedHead: created.workRevision,
      scalarValue: { kind: 'integer', lexical: '0' }, actingSubject: f.actor };
    const key = randomUUID();
    // Fail the real database boundary after Jena commits; no owner method is replaced.
    await f.accessPool.query(`CREATE FUNCTION access.${fault}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.principal_id::text = TG_ARGV[0] THEN RAISE EXCEPTION 'settlement unavailable'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${fault} BEFORE UPDATE ON access.admission
      FOR EACH ROW WHEN (NEW.state = 'sealed') EXECUTE FUNCTION access.${fault}('${f.principalId}');`);
    installed = true;
    const pending = await f.call('POST', path, body, key);
    expect(pending.status).toBe(202);
    expect(pending.headers.get('content-type')).toContain('application/json');
    expect(pending.headers.get('cache-control')).toBe('no-store');
    expect(pending.headers.get('retry-after')).toBe('1');
    expect(await pending.json()).toMatchObject({ operationId: expect.stringMatching(/^urn:rezics:operation:[0-9a-f]{64}$/),
      status: 'reconciling', phase: 'work-edit', result: null, retry: { allowed: true, afterMs: 1000 } });
    const readPath = `${path}?actingSubject=${encodeURIComponent(f.actor)}`;
    const committed = await f.json<{ revision: string; scalarValue: unknown; sourcePosition: unknown }>(await f.call('GET', readPath), 200);
    expect(committed.scalarValue).toEqual(body.scalarValue);
    await f.accessPool.query(`DROP TRIGGER ${fault} ON access.admission; DROP FUNCTION access.${fault}()`);
    installed = false;
    const replay = await f.json<{ revision: string; replayed: boolean }>(await f.call('POST', path, body, key), 200);
    expect(replay).toMatchObject({ revision: committed.revision, replayed: true });
    const after = await f.json<{ sourcePosition: unknown }>(await f.call('GET', readPath), 200);
    expect(after.sourcePosition).toEqual(committed.sourcePosition);
  } finally {
    if (installed) await f.accessPool.query(`DROP TRIGGER IF EXISTS ${fault} ON access.admission; DROP FUNCTION IF EXISTS access.${fault}()`);
    await f.close();
  }
}, 180_000);
