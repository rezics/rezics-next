import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture, author } from '../../../tests/qa/fixtures/author-credit.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../src/app.ts';
import { AccessExposure } from '../src/modules/access/exposure.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { AuthorReaders } from '../src/modules/author-page/readers.ts';
import { SourceAuthorNameStore } from '../src/modules/source/author-name.ts';
import { SourceIntakeStore } from '../src/modules/source/intake.ts';
import { GRAPHS, RV, iri } from '../src/modules/work/activate.ts';
import { authorCreditTriples } from '../src/modules/work/author-credit.ts';
import { mainSelectionDigest, selectMainDefault } from '../src/modules/work/select-main.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
interface AuthorRead { name: { displayName: string; nameSource: { revision: string; field: string } } | null;
  facts: { birthDate: { text: string; year: number | null; source: { field: string; revision: string } } | null;
    identifiers: Array<{ scheme: string; url: string; source: { field: string } }> } | null;
  record: string; totals: { works: { value: number; kind: string }; readers: { value: number; kind: string } | null };
  works: { items: Array<{ id: string; title: { value: string };
    authors: Array<{ kind: string; provider?: string; key?: string; displayName: string | null }> }>;
    nextCursor: string | null };
  links: { page: string; works: string } }

test('G-382 Open Library author pages list public credited Works with projected facts, readers and fenced pages', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const stack = await startMediaStack('author-page');
  const directory = join(resolve('.temp'), `author-page-${randomUUID()}`);
  const platformAccess = new AccessExposure(stack.accessPool);
  platformAccess.require = async (principal, exposure) => {
    expect(principal?.issuer).toBe(fixture.account.issuer);
    expect(principal?.subject).toBe(fixture.account.a.id);
    expect(['platform:catalogue-import', 'platform:catalogue-editing']).toContain(exposure ?? '');
  };
  const fixture = await authorCreditFixture(Bun.env as Record<string, string>, directory, undefined, undefined, {
    platformAccess,
  });
  try {
    const writer = await stack.member('writer');
    const base = Number(String(Date.now()).slice(-9));
    const key = `/authors/OL${base}A`, coKey = `/authors/OL${base + 1}A`, reportedKey = `/authors/OL${base + 2}A`;
    const path = (author: string, suffix = '') => `/v1/authors/open-library/${author.slice(9)}${suffix}`;
    const records = new Map<string, Record<string, unknown>>([
      [key, { name: 'Jane Austen', birth_date: 'December 16, 1775', death_date: 'July 18, 1817',
        bio: { type: '/type/text', value: 'Prose that is never projected' }, photos: [15214274],
        remote_ids: { wikidata: 'Q36322', goodreads: '1265', isni: 'not an ISNI' } }],
      [coKey, { name: 'Margaret Drabble' }]]);
    const intake = new SourceIntakeStore(stack.contentPool);
    intake.reserveOpenLibrarySlot = async () => {};
    const names = new SourceAuthorNameStore(stack.contentPool, intake, (async (url: string | URL | Request) => {
      const author = new URL(String(url)).pathname.replace(/\.json$/u, '');
      return Response.json({ key: author, type: { key: '/type/author' }, revision: 3, ...records.get(author) });
    }) as typeof fetch);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, media: stack.media,
      sourceAuthorNames: names, sourceAdoptions: fixture.adoptions,
      authorReaders: new AuthorReaders(stack.contentPool, stack.accessPool),
      account: { verify: async () => { throw new AccountAssertionDenied('Public reads only'); } } });
    const call = (target: string) => app.handle(new Request(`http://main.local${target}`));
    const read = async <T = AuthorRead>(target: string, status = 200): Promise<T> => {
      const response = await call(target);
      const text = await response.text();
      expect(response.status, text).toBe(status);
      expect(response.headers.get('cache-control')).toContain('no-store');
      return JSON.parse(text) as T;
    };
    const credit = async (work: string, author: string, ordinal: number) => {
      const triples = authorCreditTriples({ work, credit: id(), revision: id(), expectedHead: id(), sourceKey: author,
        sourceRoleKey: null, nativeOrdinal: ordinal, actingSubject: writer.actor }, stack.env.lineage.dataEpoch, '1');
      await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${triples.current} } GRAPH ${iri(GRAPHS.revisions)} { ${triples.revision} } }`);
    };

    // No public Work credits an author yet, whatever Open Library knows; an ID that is not one is invalid.
    expect((await read(path(key), 404) as unknown as { code: string }).code).toBe('work_unavailable');
    expect((await call('/v1/authors/open-library/OL0A')).status).toBe(400);
    expect((await call('/v1/authors/open-library/OL1W')).status).toBe(400);

    // Neutral titles: other integration files search the same QA population.
    const pride = await stack.publicWork(writer.actor, ['en'], `Author page solo ${base}`);
    const sanditon = await stack.publicWork(writer.actor, ['en'], `Author page shared ${base}`);
    const hidden = await stack.privateWork(writer.actor, `Author page private ${base}`);
    await credit(pride.work, key, 0);
    await credit(sanditon.work, coKey, 0);
    await credit(sanditon.work, key, 1);
    await credit(hidden.work, key, 0);

    // Before any name is projected the page names the author by ID and shows no facts.
    const unnamed = await read(path(key));
    expect(unnamed).toMatchObject({ name: null, facts: null, record: `https://openlibrary.org${key}`,
      links: { page: `/authors/open-library/${key.slice(9)}`, works: path(key, '/works') } });
    expect(unnamed.works.items.map(item => item.id).sort()).toEqual([pride.work, sanditon.work].sort());
    expect(unnamed.totals.works).toEqual({ value: 2, kind: 'exact' });

    const refreshed = await names.command(writer.principalId, randomUUID(), key, { action: 'refresh', expectedRevision: null });
    await names.command(writer.principalId, randomUUID(), coKey, { action: 'refresh', expectedRevision: null });
    const named = await read(path(key));
    expect(named.name).toMatchObject({ displayName: 'Jane Austen', nameSource: { field: '/name',
      revision: `https://rezics.com/id/${refreshed.revision}` } });
    expect(named.facts?.birthDate).toMatchObject({ text: 'December 16, 1775', year: 1775,
      source: { field: '/birth_date', revision: named.name!.nameSource.revision } });
    // Only the onward identifiers that validate are projected; prose and photos never are.
    expect(named.facts?.identifiers).toEqual([expect.objectContaining({ scheme: 'wikidata',
      url: 'https://www.wikidata.org/wiki/Q36322', source: expect.objectContaining({ field: '/remote_ids/wikidata' }) })]);
    expect(JSON.stringify(named)).not.toContain('never projected');
    expect(JSON.stringify(named)).not.toContain('15214274');
    // A co-written Work names every author in credit order.
    expect(named.works.items.find(item => item.id === sanditon.work)?.authors).toEqual([
      { kind: 'external', provider: 'open-library', key: coKey, displayName: 'Margaret Drabble' },
      { kind: 'external', provider: 'open-library', key, displayName: 'Jane Austen' }]);

    // Only public Person libraries count; duplicates, private shelves, hidden Works and intentions do not.
    const people = await Promise.all(['public', 'followers', 'private', 'intention'].map(name => stack.member(name)));
    for (const [index, person] of people.entries()) {
      const representation = (await stack.accessPool.query<{ id: string }>(`
        SELECT id::text FROM access.representation WHERE principal_id = $1 AND subject_id = $2 LIMIT 1`,
      [person.principalId, person.actor])).rows[0]!.id;
      await stack.accessPool.query(`INSERT INTO access.agent_provision
        (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind,
          display_name, principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
        VALUES ($1,$2,$3,$4,$5,'person',$6,0,'active',$7,0,$8)`,
      [randomUUID(), person.principalId, `author-${randomUUID()}`, 'a'.repeat(64), person.actor,
        person.name, stack.env.lineage.dataEpoch, representation]);
      await stack.accessPool.query(`INSERT INTO access.agent_library_visibility
        (agent_id, visibility, version) VALUES ($1,$2,1)`,
      [person.actor, ['public', 'followers', 'private', 'public'][index]]);
    }
    const [first, second, third, fourth] = people.map(person => person.actor);
    await stack.contentPool.query(`INSERT INTO reader.library_status (agent, work, status, version) VALUES
      ($1, $4, 'reading', 1), ($1, $5, 'read', 1), ($2, $5, 'read', 1), ($3, $4, 'want-to-read', 1),
      ($3, $6, 'read', 1), ($7, $4, 'read', 1)`,
    [first, second, third, pride.work, sanditon.work, hidden.work, fourth]);
    expect((await read(path(key))).totals.readers).toEqual({ value: 2, kind: 'exact' });
    await stack.accessPool.query(`UPDATE access.agent_library_visibility SET visibility = 'private', version = 2
      WHERE agent_id = $1`, [first]);
    expect((await read(path(key))).totals.readers).toEqual({ value: 1, kind: 'exact' });

    // Pages share one order and one basis; a cursor from another position restarts.
    const before = stack.fuseki.queries;
    const firstPage = await read(`${path(key)}?limit=1`);
    const overviewQueries = stack.fuseki.queries - before;
    expect(overviewQueries).toBeLessThanOrEqual(16);
    expect(firstPage.works.items).toHaveLength(1);
    const rest = await read<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      `${path(key, '/works')}?limit=1&cursor=${firstPage.works.nextCursor}`);
    expect(rest.items.map(item => item.id)).toEqual(unnamed.works.items.map(item => item.id)
      .filter(work => work !== firstPage.works.items[0]!.id));
    expect(rest.nextCursor).toBeNull();
    const moved = await stack.publicWork(writer.actor, ['en'], `Author page unrelated ${base}`);
    expect(moved.work).toBeTruthy();
    expect((await call(`${path(key, '/works')}?limit=1&cursor=${firstPage.works.nextCursor}`)).status).toBe(409);
    expect((await call(`${path(key, '/works')}?cursor=not-a-cursor`)).status).toBe(400);

    // An adoption that reports an author lists its Work once public, through the reverse index.
    const proposal = await fixture.propose(`OL${base}W`, [author(reportedKey), author(key)], `Author page adopted ${base}`);
    const adopted = await fixture.adoptWork(proposal);
    expect((await names.reportedWorks(reportedKey)).works).toEqual([adopted.work]);
    expect((await call(path(reportedKey))).status).toBe(404);
    const body = await stack.contribution(adopted.work, writer.actor, 'en', `Author page body ${randomUUID()}`);
    const selection = { context: { kind: 'main-version-default' as const, id: adopted.mainVersion },
      work: adopted.work, contribution: body.contribution, publicationDecision: body.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: writer.actor };
    expect((await selectMainDefault(stack.env, stack.admission(writer.actor, `publication:select:${adopted.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection)).outcome).toBe('succeeded');
    const reported = await read(path(reportedKey));
    expect(reported.works.items.map(item => item.id)).toEqual([adopted.work]);
    expect(reported.works.items[0]!.authors.map(item => item.key)).toEqual([reportedKey, key]);
    expect((await read(path(key))).totals.works).toEqual({ value: 3, kind: 'exact' });

    // Both indexes answer their lookups.
    const client = await stack.contentPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = async (sql: string, params: unknown[]) => (await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${sql}`, params)).rows.map(row => row['QUERY PLAN']).join('\n');
      expect(await plan(`SELECT id FROM source.conversion WHERE projection -> 'authorRefs' @> $1::jsonb`,
        [JSON.stringify([{ sourceKey: key }])])).toContain('conversion_author_refs_idx');
      expect(await plan(`SELECT DISTINCT agent FROM reader.library_status WHERE work = ANY($1::text[])
        AND status IN ('reading', 'read') ORDER BY agent LIMIT 10001`, [[pride.work]]))
        .toMatch(/library_status_(?:readers_idx|also_enjoyed_work)/);
      await client.query('ROLLBACK');
    } finally { client.release(); }

    // Removing the name withdraws the record's facts with it.
    await names.command(writer.principalId, randomUUID(), key, { action: 'remove',
      expectedRevision: refreshed.revision, reason: 'Wrong person' });
    expect(await read(path(key))).toMatchObject({ name: null, facts: null });
  } finally {
    await fixture.close();
    await stack.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
