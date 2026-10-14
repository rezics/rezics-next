import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';

export interface BooksCatalogue {
  handle: string;
  realm: string;
  books: { work: string; title: string }[];
  outside: { work: string; title: string };
}

const run = process.env.REZICS_QA_RUN_ID;
if (!run || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(run)) throw new Error('Books preparation needs an isolated QA stack');
const cache = `.temp/books-catalogue-${run}.json`;
if (existsSync(cache)) {
  console.log(readFileSync(cache, 'utf8'));
} else {
  const session = await platformAdministratorSession(process.env,
    'openid access:grant agent:create work:create work:edit work:read space:create zone:edit realm:adopt library:write');
  const short = (iri: string) => iri.slice(-36);
  async function request<T>(method: string, path: string, body?: object): Promise<T> {
    const key = randomUUID();
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await fetch(new URL(path, session.mainOrigin), {
        method, headers: { authorization: `Bearer ${await session.session.current()}`,
          'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (response.status === 202) {
        await new Promise(done => setTimeout(done, 250));
        continue;
      }
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
      return JSON.parse(text) as T;
    }
    throw new Error(`${method} ${path}: command stayed pending`);
  }
  // Public provisioning supplies the editor's controller and author baselines.
  // Only fixture authority is prepared in Access; product records all use HTTP.
  const { agent: actor } = await request<{ agent: string }>('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Books catalogue editor',
  });
  async function authorize(scope: string, action: string) {
    if (!process.env.ACCESS_DATABASE_URL) throw new Error('Books preparation needs the isolated QA Access database');
    const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await grantFixtureAuthority(client, { scope, requireDispatch: true,
        representations: [{ principalId: session.principalId, actor, action, lifetime: '8 hours' }],
        grant: { actor, action, lifetime: '8 hours' } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
  await authorize('space:create:root', 'space.create');
  const handle = 'launch-books';
  const space = await request<{ space: string; realm: string }>('POST', '/v1/spaces', {
    profile: 'space-realm-v2', name: 'Books', handle, capabilities: ['realm'], actingSubject: actor,
  });
  const zone = `https://rezics.com/id/${randomUUID()}`;
  await authorize(`zone:edit:${zone}`, 'zone.edit');
  await request('POST', '/v1/zones', { zone, space: space.space, name: 'Books', language: 'en',
    disclosure: 'public', actingSubject: actor });
  const config = await request<{ revision: string }>('GET',
    `/v1/zones/${short(zone)}/configuration?actingSubject=${encodeURIComponent(actor)}`);
  await request('PUT', `/v1/zones/${short(zone)}/configuration`, {
    expectedHead: config.revision, defaultRealm: space.realm, actingSubject: actor,
  });
  await authorize(`publication:adopt:${space.realm}`, 'publication.adopt');

  async function book(title: string, adopt: boolean) {
    const work = await request<{ work: string; mainVersion: string }>('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
      semanticTypes: ['https://schema.org/Book'], actingSubject: actor,
    });
    const draft = await request<{ contribution: string; draftRevision: string }>('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en', body: `${title}\nA reader's coastal story.`, actingSubject: actor,
    });
    const published = await request<{ publicationDecision: string }>('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    });
    const selection = { work: work.work, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null, actingSubject: actor };
    await request('POST', '/v1/publication-selections', { ...selection, profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer' });
    if (adopt) await request('POST', '/v1/publication-selections', { ...selection, profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: space.realm }, mainVersion: work.mainVersion, selectionBasis: 'realm-manager-review' });
    return { work: work.work, title };
  }
  const books = [await book('The Lighthouse Keeper’s Almanac', true), await book('Letters from the Harbour', true)];
  const outside = await book('The Lighthouse Keeper’s Unlisted Diary', false);
  for (const saved of books) await request('PUT', `/v1/works/${short(saved.work)}/reader-status`, {
    actingSubject: session.actingSubject, expectedVersion: 0, status: 'want-to-read',
  });
  const seed: BooksCatalogue = { handle, realm: space.realm, books, outside };
  mkdirSync('.temp', { recursive: true });
  writeFileSync(cache, JSON.stringify(seed));
  console.log(JSON.stringify(seed));
}
