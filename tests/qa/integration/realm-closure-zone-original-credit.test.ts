import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { personaSessions } from '../support/personas.ts';
import { createRestoreFixtureTiming } from '../support/restore-fixture-timing.ts';
import { publishClosureOriginals, type ClosureOriginal } from './outcomes/realm/closure-original-credit-setup.ts';
import { prepareClosureZoneHome } from './outcomes/realm/closure-zone-home-setup.ts';

type Credit = { id: string; agent: string; role: string };
type RequestEvidence = {
  persona: string; caller: string | null; actingSubject: string | null;
  method: string; path: string; body?: unknown; idempotencyKey?: string;
  elapsedMs: number; sinceStartMs: number;
  answer: { status: number; body: string; etag: string | null };
};

test('Zone originals retain native author credit and publish the prepared home identity', async () => {
  const started = performance.now();
  const directory = process.env.REZICS_QA_ARTIFACT_DIR ?? '.temp/closure-zone-original-credit';
  mkdirSync(directory, { recursive: true });
  const timing = createRestoreFixtureTiming({ artifactDirectory: directory });
  const file = join(directory, `closure-zone-original-credit-${timing.fixtureId}.jsonl`);
  const record = (value: unknown) => appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const requests: RequestEvidence[] = [];
  record({ kind: 'source', source: import.meta.path, runId: process.env.REZICS_QA_RUN_ID });
  const sessions = await timing.phase('persona-preparation', () => personaSessions('public'));
  try {
    for (const persona of ['owner', 'visitor'] as const) {
      const person = sessions[persona];
      const call = person.main;
      person.main = async (method, path, body, key, options) => {
        const idempotencyKey = key ?? (method === 'POST' ? randomUUID() : undefined);
        const at = performance.now();
        const input = { persona, caller: person.accountId, actingSubject: person.actingSubject,
          method, path, body, idempotencyKey };
        record({ kind: 'request-start', ...input });
        const response = await call(method, path, body, idempotencyKey, options);
        const request = { ...input, elapsedMs: performance.now() - at,
          sinceStartMs: performance.now() - started,
          answer: { status: response.status, body: await response.clone().text(), etag: response.headers.get('etag') } };
        requests.push(request);
        record({ kind: 'request-answer', ...request });
        return response;
      };
    }
    const originals: ClosureOriginal[] = [];
    // The Zone journey calls this same setup with its own sessions and inventory.
    await timing.phase('original-publication', () => publishClosureOriginals(sessions, originals,
      `Closuregarden${randomUUID().replaceAll('-', '')}`));
    expect(originals).toHaveLength(3);
    expect(new Set(originals.map(original => original.work)).size).toBe(3);
    await timing.phase('public-credit-and-selections', async () => {
      for (const original of originals) {
        const root = `/v1/works/${original.work.slice(-36)}`;
        const creation = requests.find(request => request.method === 'POST' && request.path === '/v1/works'
          && JSON.parse(request.answer.body).work === original.work)!;
        expect(creation.answer.status).toBe(201);
        expect(creation.body).toMatchObject({ profile: 'metadata-only-v1', authoring: 'own-work',
          language: 'en', semanticTypes: ['https://schema.org/Book'], actingSubject: sessions.owner.actingSubject });
        expect(JSON.parse(creation.answer.body)).toMatchObject({ work: original.work,
          mainVersion: original.mainVersion, workRevision: original.workRevision });
        const supplied = requests.find(request => request.method === 'GET'
          && request.path === `${root}/agent-credits?actingSubject=${encodeURIComponent(sessions.owner.actingSubject!)}`)!;
        expect(supplied.caller).toBe(sessions.owner.accountId);
        expect(supplied.answer.status).toBe(200);
        const initial = JSON.parse(supplied.answer.body) as { items: Credit[]; nextCursor: string | null };
        expect(initial.items).toHaveLength(1);
        expect(initial.items[0]).toMatchObject({ agent: sessions.owner.actingSubject, role: 'author' });
        expect(initial.nextCursor).toBeNull();
        const work = await sessions.visitor.main('GET', root);
        expect(work.status).toBe(200);
        expect(await work.json()).toMatchObject({ disclosure: 'public', mainVersion: original.mainVersion });
        const credits = await sessions.visitor.main('GET', `${root}/agent-credits`);
        expect(credits.status).toBe(200);
        const inventory = await credits.json() as { items: Credit[]; nextCursor: string | null };
        // Publication advances the source position; the native credit stays identical.
        expect(inventory.items).toEqual(initial.items);
        expect(inventory.nextCursor).toBeNull();
        expect(requests.filter(request => request.method === 'POST'
          && request.path === `${root}/agent-credits`)).toHaveLength(0);
        const publication = requests.find(request => request.path === '/v1/contribution-publications'
          && JSON.parse(request.answer.body).publicationDecision === original.publicationDecision)!;
        expect(publication.answer.status).toBe(201);
        expect(publication.body).toMatchObject({ contribution: original.contribution,
          rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: sessions.owner.actingSubject });
        const selections = requests.filter(request => request.path === '/v1/publication-selections'
          && (request.body as { work: string }).work === original.work);
        expect(selections).toHaveLength(2);
        expect(selections.map(request => request.answer.status)).toEqual([201, 201]);
        expect(selections[0]!.body).toMatchObject({ profile: 'main-default-selection-v1',
          context: { kind: 'main-version-default', id: original.mainVersion },
          contribution: original.contribution, publicationDecision: original.publicationDecision,
          expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: sessions.owner.actingSubject });
        expect(selections[1]!.body).toMatchObject({ profile: 'realm-local-selection-v1',
          context: { kind: 'realm-local', id: sessions.realm }, mainVersion: original.mainVersion,
          contribution: original.contribution, publicationDecision: original.publicationDecision,
          expectedSelectionHead: null, selectionBasis: 'realm-manager-review', actingSubject: sessions.owner.actingSubject });
        expect(JSON.parse(selections[1]!.answer.body)).toMatchObject({ selection: original.selection });
      }
    });
    await timing.phase('independent-zone-home-publication', async () => {
      const home = await prepareClosureZoneHome(sessions, originals[0]!);
      const root = `/v1/zones/${sessions.zone.slice(-36)}`;
      const configuration = requests.find(request => request.method === 'PUT'
        && request.path === `${root}/configuration`)!;
      const configurationReads = requests.filter(request => request.method === 'GET'
        && request.path.startsWith(`${root}/configuration?`));
      expect(configuration.body).toMatchObject({ prepareHomeDocument: true,
        expectedHead: JSON.parse(configurationReads[0]!.answer.body).revision,
        defaultRealm: sessions.realm, actingSubject: sessions.owner.actingSubject });
      expect(JSON.parse(configurationReads[1]!.answer.body).configuration.homeDocument).toBe(home.homeDocument);
      const saved = requests.find(request => request.method === 'POST' && request.path === '/v1/content-drafts')!;
      expect(saved.body).toMatchObject({ resourceId: home.homeDocument,
        variantId: home.variantId, expectedHead: null, actingSubject: sessions.owner.actingSubject });
      const publication = requests.find(request => request.method === 'POST'
        && request.path === `${root}/site-publications`)!;
      expect(publication.answer.status).toBe(201);
      expect(publication.body).toMatchObject({ routesRevision: home.mount.revision,
        expectedHead: JSON.parse(configurationReads.at(-1)!.answer.body).revision,
        navigationRevision: home.mount.revision, actingSubject: sessions.owner.actingSubject,
        pages: [{ page: home.homeDocument, variantId: home.variantId,
          revisionId: home.draft.revisionId, byteDigest: home.draft.byteDigest,
          contentEpoch: home.draft.sourcePosition.dataEpoch }] });
      expect(home.published).toMatchObject({ homeDocument: home.homeDocument,
        routesRevision: home.mount.revision,
        navigationRevision: home.mount.revision,
        pages: [{ page: home.homeDocument, variantId: home.variantId, revisionId: home.draft.revisionId }] });
      // The Zone home manifest has its own head; its selected page retains the Content revision.
      expect(home.published.homeRevision).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
      const route = await sessions.visitor.main('GET', `${root}/routes?path=/`);
      expect(route.status).toBe(200);
      expect(await route.json()).toMatchObject({ realm: sessions.realm, page: {
        reference: { resourceId: home.homeDocument, revisionId: home.draft.revisionId,
          provenance: { author: sessions.owner.actingSubject, rightsBasis: 'original-contribution' } },
      } });
      const revision = await sessions.visitor.main('GET', `/v1/content-revisions/${home.draft.revisionId}`);
      expect(revision.status).toBe(200);
      expect(JSON.stringify(await revision.json())).toContain('Independent original Zone home document');
      const mounted = await sessions.visitor.main('GET', `${root}/routes?path=/original`);
      expect(mounted.status).toBe(200);
      expect(await mounted.json()).toMatchObject({ resource: { id: originals[0]!.work } });
    });
  } finally {
    record({ kind: 'path-timing', preparationSeconds: sessions.elapsedSeconds,
      elapsedSeconds: (performance.now() - started) / 1000 });
    await sessions.close();
  }
}, 180_000);
