import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { identityHarness, iri } from './source-identity-harness.ts';

const short = (value: string) => value.split('/').at(-1)!;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('LIVE06: current Open Library redirect capture never transfers a native identity or grant', async () => {
  // A known merged Work is a scenario candidate; its redirect shape is checked
  // against the provider on every run. The admitted bytes are reused below.
  const fromId = 'OL31882528W';
  const h = await identityHarness({ realAccount: true, acquisition: 'live' });
  try {
    const key = randomUUID();
    const request = { profile: 'open-library-works-run-v1', workIds: [fromId],
      editions: false, ratings: false, frontier: false };
    const first = await h.post('/v1/sources/acquisitions', 'owner', request, key);
    expect(first.status).toBe(201);
    const result = await first.json() as { run: { run: string; state: string;
      surfaces: Array<{ surface: string; outcome: { outcome: string };
        captures: Array<{ observation: string; record: string; externalId: string;
          byteDigest: string; fetchedAt: string }> }> } };
    const works = result.run.surfaces.find(surface => surface.surface === 'works')!;
    expect(result.run.state, JSON.stringify(works.outcome)).toBe('completed');
    expect(works.outcome.outcome).toBe('qualified');
    expect(works.captures).toHaveLength(1);
    const from = works.captures.find(capture => capture.externalId === fromId)!;
    const stored = (await h.pool.query<{ raw_bytes: Buffer; byte_digest: string; capture: {
      fetchedAt: string; url: string } }>(`SELECT raw_bytes, byte_digest, capture
      FROM source.observation WHERE id = $1`, [short(from.observation)])).rows[0]!;
    expect(stored.byte_digest).toBe(sha(stored.raw_bytes));
    expect(stored.byte_digest).toBe(from.byteDigest);
    expect(stored.capture.url).toBe(`https://openlibrary.org/works/${fromId}.json`);
    expect(stored.capture.fetchedAt).toBe(from.fetchedAt);
    const observed = await h.get(`/v1/sources/observations/${short(from.observation)}`, 'owner');
    expect(observed.status).toBe(200);
    const observation = await observed.json() as { rawBytesBase64: string };
    const redirect = JSON.parse(Buffer.from(observation.rawBytesBase64, 'base64').toString('utf8')) as {
      key: string; type: { key: string }; location: string };
    expect(redirect).toMatchObject({ key: `/works/${fromId}`, type: { key: '/type/redirect' } });
    const destination = /^\/works\/(OL[1-9][0-9]{0,11}W)$/.exec(redirect.location);
    expect(destination).not.toBeNull();
    const toId = destination![1]!;
    const destinationRequest = { ...request, workIds: [toId] };
    const destinationRun = await h.post('/v1/sources/acquisitions', 'owner', destinationRequest, randomUUID());
    expect(destinationRun.status).toBe(201);
    const destinationResult = await destinationRun.json() as typeof result;
    expect(destinationResult.run.state).toBe('completed');
    const to = destinationResult.run.surfaces.find(surface => surface.surface === 'works')!.captures[0]!;
    expect(to.externalId).toBe(toId);
    expect(from.record).not.toBe(to.record);
    const plan = (await h.pool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
      'Temp Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
      SELECT o.raw_bytes, o.byte_digest, o.retention, o.coverage, t.external_id,
        f.provider, f.namespace FROM source.observation o
      JOIN source.record f ON f.id = o.record_id JOIN source.record t ON t.id = $3
      WHERE o.id = $4 AND o.principal_id = $1 AND f.id = $2
        AND t.provider = f.provider AND t.namespace = f.namespace`,
    [h.principalId, short(from.record), short(to.record), short(from.observation)]))
      .rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Actual Rows']).toBe(1);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(64);
    expect(plan['Temp Read Blocks']).toBe(0);
    expect(redirect.location).toBe(`/works/${toId}`);
    const replay = await h.post('/v1/sources/acquisitions', 'owner', request, key);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { run: { run: string } }).run.run).toBe(result.run.run);
    const change = await h.post('/v1/sources/identity-changes', 'owner', {
      profile: 'source-record-identity-change-v1', kind: 'redirect',
      fromRecord: from.record, toRecord: to.record,
      observation: from.observation, evidencePointer: '/location' });
    expect(change.status).toBe(201);
    const evidence = await change.json() as { change: { change: string;
      nativeEffect: string; toExternalId: string } };
    expect(evidence.change).toMatchObject({ nativeEffect: 'none', toExternalId: toId });
    const fromTarget = iri(randomUUID()), toTarget = iri(randomUUID()), actor = iri(randomUUID());
    await h.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
    await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`work:read:${fromTarget}`]);
    await h.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.read',now() + interval '1 hour')`,
    [randomUUID(), h.principalId, actor]);
    const grantId = randomUUID();
    await h.accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.read',now() + interval '1 hour')`,
    [grantId, actor, `work:read:${fromTarget}`]);
    const principal = await h.verifyOwner();
    expect(await h.access.canReadWork(principal, actor, fromTarget)).toBe(true);
    expect(await h.access.canReadWork(principal, actor, toTarget)).toBe(false);
    expect((await h.post('/v1/sources/identity-corrections', 'owner', {
      profile: 'source-identity-correction-proposal-v1', change: evidence.change.change,
      fromTarget, toTarget }, randomUUID())).status).toBe(409);
    expect((await h.accessPool.query('SELECT scope_id FROM access.permission_grant WHERE id = $1',
      [grantId])).rows[0]?.scope_id).toBe(`work:read:${fromTarget}`);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM source.record WHERE id IN ($1,$2)',
      [short(from.record), short(to.record)])).rows[0]?.n).toBe(2);
  } finally { await h.close(); }
}, 60_000);
