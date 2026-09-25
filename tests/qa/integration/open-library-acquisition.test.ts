import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';

test('LIVE01/LIVE02/LIVE09/LIVE11: bounded Open Library Work capture stages one exact private observation', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const issuer = 'https://qa-open-library.test';
  const owner = { issuer, subject: randomUUID() };
  const other = { issuer, subject: randomUUID() };
  const ownerId = randomUUID();
  const otherId = randomUUID();
  let mode: 'good' | 'malformed' = 'good';
  let fetches = 0;
  const openLibraryFetch = (async (url: string, init: RequestInit) => {
    fetches++;
    expect(url).toMatch(/^https:\/\/openlibrary\.org\/works\/OL[1-9][0-9]*W\.json$/);
    expect(init.redirect).toBe('manual');
    if (mode === 'malformed') return new Response('{partial', {
      headers: { 'content-type': 'application/json' } });
    const workId = url.split('/').at(-1)!.slice(0, -5);
    return new Response(`{"key":"/works/${workId}","title":"Fixture","revision":7,"extra":null}`,
      { headers: { 'content-type': 'application/json', etag: '"fixture-7"' } });
  }) as typeof fetch;
  const account = { verify: async (request: Request, required: readonly string[]) => {
    const token = request.headers.get('authorization');
    if (token === 'Bearer owner' && ['source:acquire', 'source:read'].includes(required[0]!)) return owner;
    if (token === 'Bearer other' && required[0] === 'source:read') return other;
    throw new AccountAssertionDenied('scope is unavailable');
  } };
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const app = createMainApp(fuseki, {
    environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp/open-library-unused' },
    account, access: new AccessAdmissionRegistry(accessPool),
    sourceIntake: new SourceIntakeStore(contentPool), openLibraryFetch,
  });
  const route = '/v1/sources/acquisitions/open-library/works';
  const body = (workId: string) => ({ profile: 'open-library-work-acquisition-v1', workId });
  const post = (token: string, workId: string, key: string) => app.handle(new Request(
    `http://main.local${route}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify(body(workId)) }));
  const read = (token: string, id: string) => app.handle(new Request(
    `http://main.local/v1/sources/observations/${id}`,
    { headers: { authorization: `Bearer ${token}` } }));
  try {
    await migrateContent(contentPool);
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3), ($4, $2, $5)`,
    [ownerId, issuer, owner.subject, otherId, other.subject]);
    const key = `open-library-${randomUUID()}`;
    expect((await post('denied', 'OL45804W', key)).status).toBe(401);
    expect(fetches).toBe(0);
    const acquired = await post('owner', 'OL45804W', key);
    expect(acquired.status).toBe(201);
    const first = await acquired.json() as { observation: { observation: string;
      profile: string; externalId: string; rawBytesBase64: string;
      capture: { url: string; etag: string; status: number } }; replayed: boolean };
    expect(first.replayed).toBe(false);
    expect(first.observation).toMatchObject({ profile: 'source-acquisition-v1',
      externalId: 'OL45804W', capture: { status: 200, etag: '"fixture-7"',
        url: 'https://openlibrary.org/works/OL45804W.json' } });
    expect(Buffer.from(first.observation.rawBytesBase64, 'base64').toString('utf8'))
      .toBe('{"key":"/works/OL45804W","title":"Fixture","revision":7,"extra":null}');
    expect(fetches).toBe(1);
    const replay = await post('owner', 'OL45804W', key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ observation: first.observation, replayed: true });
    expect(fetches).toBe(1);
    expect((await post('owner', 'OL7353617W', key)).status).toBe(409);
    expect(fetches).toBe(1);
    const id = first.observation.observation.split('/').at(-1)!;
    expect(await (await read('owner', id)).json()).toEqual(first.observation);
    expect((await read('other', id)).status).toBe(404);
    mode = 'malformed';
    const retryKey = `retry-${randomUUID()}`;
    expect((await post('owner', 'OL7353617W', retryKey)).status).toBe(503);
    expect((await contentPool.query(`SELECT observation_id FROM source.intake_receipt
      WHERE principal_id = $1 AND idempotency_key = $2`, [ownerId, retryKey])).rowCount).toBe(0);
    mode = 'good';
    expect((await post('owner', 'OL7353617W', retryKey)).status).toBe(201);
    const captures = await contentPool.query<{ profile: string }>(`
      SELECT capture ->> 'profile' AS profile FROM source.observation
      WHERE principal_id = $1`, [ownerId]);
    expect(captures.rows.map(row => row.profile)).toEqual([
      'open-library-work-acquisition-v1', 'open-library-work-acquisition-v1' ]);
  } finally {
    await Promise.all([contentPool.end(), accessPool.end()]);
  }
});
