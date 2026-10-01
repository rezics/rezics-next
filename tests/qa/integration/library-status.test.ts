import { replacementController } from './g-523-controller-fixture.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { projectDiscoveryBatch } from '../../../services/main/src/modules/discovery/source.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { activateMetadataWork, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { InvalidLibraryStatus, LibraryStatusConflict, ReaderLibraryStatusStore,
  StaleLibraryStatus } from '../../../services/main/src/modules/library/status.ts';
import { prepareLibraryShelves } from '../../../services/main/src/modules/library/backfill.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test.each(['initial context', 'retained context'])(
  'G285 G352: reader status, own ratings, serial progress and discovery survive ordinary member authority (%s)', async () => {
  const stack = await startMediaStack('reader-library');
  try {
    const status = new ReaderLibraryStatusStore(stack.contentPool);
    const agent = id();
    const work = id();
    const other = id();
    expect(await status.batch(agent, [work])).toEqual([{ work, status: null,
      startedOn: null, finishedOn: null, version: 0, changedAt: null }]);
    const input = { agent, work, status: 'want-to-read' as const, startedOn: null,
      finishedOn: null, expectedVersion: 0, idempotencyKey: randomUUID() };
    const first = await status.write(input);
    expect(first).toMatchObject({ work, status: 'want-to-read', version: 1, replayed: false });
    expect(await new ReaderLibraryStatusStore(stack.contentPool).write(input))
      .toEqual({ ...first, replayed: true });
    await expect(status.write({ ...input, status: 'reading' })).rejects.toBeInstanceOf(LibraryStatusConflict);
    await expect(status.write({ ...input, idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(StaleLibraryStatus);
    const read = await status.write({ ...input, status: 'read', startedOn: '2026-01-01',
      finishedOn: '2026-01-10', expectedVersion: 1, idempotencyKey: randomUUID() });
    expect(read).toMatchObject({ status: 'read', startedOn: '2026-01-01',
      finishedOn: '2026-01-10', version: 2 });
    const clear = await status.write({ ...input, status: null, expectedVersion: 2,
      idempotencyKey: randomUUID() });
    expect(clear).toMatchObject({ status: null, version: 3 });
    expect(await status.counts(agent)).toEqual({ 'want-to-read': 0, reading: 0, read: 0 });
    expect((await status.shelves(agent)).map(shelf => shelf.count)).toEqual([0, 0, 0]);
    await expect(status.write({ ...input, status: 'read', startedOn: '2026-02-30',
      finishedOn: null, expectedVersion: 3, idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(InvalidLibraryStatus);
    const two = await Promise.allSettled([
      status.write({ ...input, work: other, expectedVersion: 0, idempotencyKey: randomUUID() }),
      status.write({ ...input, work: other, status: 'reading', expectedVersion: 0,
        idempotencyKey: randomUUID() }),
    ]);
    expect(two.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(two.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((two.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(StaleLibraryStatus);
    const states = await status.batch(agent, [work, other]);
    expect(states[0]).toMatchObject({ status: null, version: 3 });
    expect(states[1]).toMatchObject({ version: 1 });

    const a = await stack.member('reader-a');
    const b = await stack.member('reader-b');
    const tokens = new Map([[a.token, { ...a.principal, emailVerified: true }],
      [b.token, { ...b.principal, emailVerified: true }]]);
    const structureObjects = stack.objects('reader-library/structure/');
    await structureObjects.initialize();
    const discovery = new DiscoveryProjection(stack.accessPool);
    let ratingConsent = true;
    const deps = { environment: stack.env, access: stack.access, discovery,
      account: { verify: async (request: Request, scopes: readonly string[]) => {
        if (scopes.includes('rating:read') && !ratingConsent) throw new AccountAssertionDenied('Missing rating consent');
        const principal = tokens.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
        if (!principal) throw new Error('unknown bearer');
        return principal;
      } }, libraryStatus: status, libraryRatings: new ReaderLibraryRatings(stack.accessPool),
      profiles: new ProfilesAccess(stack.accessPool), personPreferences: new PersonPreferencesStore(stack.accessPool),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      media: stack.media, mediaAccess: stack.mediaAccess, structureObjects };
    const app = createMainApp(stack.fuseki, deps);
    const signedOut = await app.handle(new Request(`http://main.local/v1/works/${work.slice(-36)}/reader-state`));
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get('cache-control')).toContain('public');
    expect(await signedOut.json()).toMatchObject({ profile: 'reader-work-state-v1',
      status: { status: null, version: 0 }, rating: { global: null, realm: null } });
    const denied = await app.handle(new Request(`http://main.local/v1/me/shelves?actingSubject=${encodeURIComponent(a.actor)}`,
      { headers: { authorization: `Bearer ${b.token}` } }));
    expect(denied.status).toBe(403);

    const provision = await app.handle(new Request('http://main.local/v1/agents', { method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'agent-provision-v1', displayName: 'Library reader', kind: 'person' }) }));
    expect(provision.status).toBe(201);
    const person = await provision.json() as { agent: string };
    const publicWork = await stack.publicWork(person.agent, ['en'], 'Library Work');
    const route = `/v1/works/${publicWork.work.slice(-36)}`;
    const actingSubject = encodeURIComponent(person.agent);
    const view = async () => app.handle(new Request(
      `http://main.local${route}/reader-state?actingSubject=${actingSubject}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    const initial = await view();
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ work: publicWork.work,
      status: { status: null, version: 0 }, customShelves: [],
      rating: { global: null, realm: null }, progress: null });
    const saved = await app.handle(new Request(`http://main.local${route}/reader-status`, { method: 'PUT',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ actingSubject: person.agent, expectedVersion: 0,
        status: 'reading', startedOn: null, finishedOn: null }) }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ status: 'reading', version: 1 });
    const after = await view();
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ status: { status: 'reading', version: 1 } });

    const profilePath = `/v1/agents/${person.agent.slice(-36)}`;
    const profileBefore = await app.handle(new Request(`http://main.local${profilePath}`));
    expect(await profileBefore.json()).toMatchObject({ library: {
      visibility: 'private', statusShelvesVisible: false } });
    const ownerProfile = await app.handle(new Request(
      `http://main.local${profilePath}?actingSubject=${encodeURIComponent(person.agent)}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(await ownerProfile.json()).toMatchObject({ library: {
      visibility: 'private', statusShelvesVisible: true },
      links: { statusShelves: `/v1/me/shelves?actingSubject=${encodeURIComponent(person.agent)}` } });
    const publicShelfPath = `${profilePath}/shelves`;
    expect((await app.handle(new Request(`http://main.local${publicShelfPath}`))).status).toBe(404);
    const visibilityPath = `${profilePath}/library-visibility`;
    const ownerVisibility = await app.handle(new Request(`http://main.local${visibilityPath}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(await ownerVisibility.json()).toMatchObject({ visibility: 'private', version: 0 });
    expect((await app.handle(new Request(`http://main.local${visibilityPath}`,
      { headers: { authorization: `Bearer ${b.token}` } }))).status).toBe(403);
    const visibilityBody = { visibility: 'public', expectedVersion: 0 };
    const visibilityKey = randomUUID();
    const visibilityRequest = (token: string, body: unknown, key = randomUUID()) => app.handle(new Request(
      `http://main.local${visibilityPath}`, { method: 'PUT', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body) }));
    expect((await visibilityRequest(b.token, visibilityBody)).status).toBe(403);
    expect((await visibilityRequest(a.token, { visibility: 'followers', expectedVersion: 0 })).status).toBe(400);
    const published = await visibilityRequest(a.token, visibilityBody, visibilityKey);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ visibility: 'public', version: 1, replayed: false });
    expect(await (await visibilityRequest(a.token, visibilityBody, visibilityKey)).json())
      .toMatchObject({ visibility: 'public', version: 1, replayed: true });
    expect((await visibilityRequest(a.token, { visibility: 'private', expectedVersion: 0 }, visibilityKey)).status).toBe(409);
    expect((await visibilityRequest(a.token, { visibility: 'private', expectedVersion: 0 })).status).toBe(409);
    expect(await (await app.handle(new Request(`http://main.local${profilePath}`))).json())
      .toMatchObject({ library: { visibility: 'public', statusShelvesVisible: true },
        links: { statusShelves: publicShelfPath } });
    const hiddenWork = await stack.privateWork(person.agent, 'Hidden shelf Work');
    await status.write({ agent: person.agent, work: hiddenWork.work, status: 'reading',
      startedOn: null, finishedOn: null, expectedVersion: 0, idempotencyKey: randomUUID() });
    const secondPublic = await stack.publicWork(person.agent, ['en'], 'Second shelf Work');
    await status.write({ agent: person.agent, work: secondPublic.work, status: 'reading',
      startedOn: null, finishedOn: null, expectedVersion: 0, idempotencyKey: randomUUID() });
    const publicShelves = await app.handle(new Request(`http://main.local${publicShelfPath}`));
    expect(publicShelves.status).toBe(200);
    expect(await publicShelves.json()).toMatchObject({ statusShelves: expect.arrayContaining([
      expect.objectContaining({ status: 'reading', count: 2 })]) });
    const publicPagePath = `${publicShelfPath}/status/reading/works?limit=1`;
    const firstPublic = await app.handle(new Request(`http://main.local${publicPagePath}`));
    expect(firstPublic.status).toBe(200);
    const firstPublicBody = await firstPublic.json() as { items: { work: string; card: { title: unknown } }[];
      nextCursor: string; statusCount: number };
    expect(firstPublicBody.statusCount).toBe(2);
    expect(firstPublicBody.items).toHaveLength(1);
    expect(firstPublicBody.items[0]?.card.title).toBeTruthy();
    const secondPublicPage = await app.handle(new Request(`http://main.local${publicPagePath}`
      + `&cursor=${encodeURIComponent(firstPublicBody.nextCursor)}`));
    expect(secondPublicPage.status).toBe(200);
    const secondPublicBody = await secondPublicPage.json() as { items: { work: string }[] };
    expect(new Set([firstPublicBody.items[0]?.work, secondPublicBody.items[0]?.work]))
      .toEqual(new Set([publicWork.work, secondPublic.work]));
    await status.write({ agent: person.agent, work: secondPublic.work, status: 'read',
      startedOn: null, finishedOn: null, expectedVersion: 1, idempotencyKey: randomUUID() });
    expect((await app.handle(new Request(`http://main.local${publicPagePath}`
      + `&cursor=${encodeURIComponent(firstPublicBody.nextCursor)}`))).status).toBe(409);
    expect((await visibilityRequest(a.token, { visibility: 'private', expectedVersion: 1 })).status).toBe(200);
    expect((await app.handle(new Request(`http://main.local${publicShelfPath}`))).status).toBe(404);
    const racingVisibility = await Promise.all([
      visibilityRequest(a.token, { visibility: 'private', expectedVersion: 2 }),
      visibilityRequest(a.token, { visibility: 'private', expectedVersion: 2 }),
    ]);
    expect(racingVisibility.map(result => result.status).sort()).toEqual([200, 409]);
    await status.write({ agent: person.agent, work: hiddenWork.work, status: null,
      startedOn: null, finishedOn: null, expectedVersion: 1, idempotencyKey: randomUUID() });
    await status.write({ agent: person.agent, work: secondPublic.work, status: null,
      startedOn: null, finishedOn: null, expectedVersion: 2, idempotencyKey: randomUUID() });

    const collection = id();
    const olderCollection = id();
    const grant = async (scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), a.principalId, person.agent, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), person.agent, scope, action]);
    };
    await grant(`collection:edit:${collection}`, 'collection.edit');
    await grant(`collection:edit:${olderCollection}`, 'collection.edit');
    await grant(`work:read:${publicWork.work}`, 'work.read');
    const olderResponse = await app.handle(new Request('http://main.local/v1/collections', { method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ collection: olderCollection, name: 'Public shelf', disclosure: 'public',
        actingSubject: person.agent }) }));
    expect(olderResponse.status, await olderResponse.clone().text()).toBe(201);
    const createCollection = await app.handle(new Request('http://main.local/v1/collections', { method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ collection, name: 'Private favorites', disclosure: 'private',
        actingSubject: person.agent }) }));
    expect(createCollection.status).toBe(201);
    const createdCollection = await createCollection.json() as { structure: string; revision: string };
    const change = await app.handle(new Request(`http://main.local/v1/collections/${collection.slice(-36)}/changes`, { method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ actingSubject: person.agent, expectedHead: createdCollection.revision,
        operations: [{ op: 'insert', parent: createdCollection.structure, position: 'last',
          role: 'member', target: publicWork.work, selection: { mode: 'follow-context' } }] }) }));
    expect(change.status).toBe(200);
    const withCollection = await view();
    expect(withCollection.status).toBe(200);
    expect(await withCollection.json()).toMatchObject({ customShelves: [
      { id: collection, name: 'Private favorites', disclosure: 'private' }] });

    // A preceding file may already have installed the deployment's global
    // context. A second active one makes the reader's default ambiguous.
    const contexts = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?context a rv:GlobalRatingContext ; rv:contextState rv:Active }
    } LIMIT 2`)).results?.bindings ?? [];
    expect(contexts.length).toBeLessThanOrEqual(1);
    let context: { context: string };
    if (contexts[0]?.context) context = { context: contexts[0].context.value };
    else {
      await grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
      const response = await app.handle(new Request('http://main.local/v1/global-rating-contexts', {
        method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() },
        body: JSON.stringify({ profile: 'global-rating-standing-context-v1', question: 'Quality',
          actingSubject: person.agent }) }));
      expect(response.status).toBe(201);
      context = await response.json() as { context: string };
    }
    await grant(`rating:observe:${context.context}`, 'rating.observation.set');
    // G352: ordinary readers can see their own rating without a context-wide
    // observation-read grant. Provisioned Person control is their authority.
    expect(await stack.access.canReadStandingRating({ ...a.principal, emailVerified: true },
      person.agent, context.context)).toBe(false);
    const observation = await app.handle(new Request('http://main.local/v1/global-rating-observations', {
      method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'global-rating-standing-observation-v1',
        context: context.context, work: publicWork.work, mainVersion: publicWork.mainVersion,
        expectedRevisionHead: null, value: 5, actingSubject: person.agent }) }));
    expect(observation.status).toBe(201);
    const observed = await observation.json() as { observation: string; observationRevision: string };
    // A preceding test or ordinary erasure may leave unrelated tombstones.
    // The current-head erasure check must correlate to this observation.
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(id())} a rv:ErasedRevision } }`);
    const withRating = await view();
    expect(withRating.status).toBe(200);
    expect(await withRating.json()).toMatchObject({ rating: { global: { value: 5,
      availability: 'available' } } });
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(observed.observationRevision)} a rv:ErasedRevision } }`);
    try { expect((await view()).status).toBe(503); }
    finally {
      await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(observed.observationRevision)} a rv:ErasedRevision } }`);
    }
    ratingConsent = false;
    expect((await view()).status).toBe(401);
    ratingConsent = true;
    expect((await app.handle(new Request(
      `http://main.local${route}/reader-state?actingSubject=${actingSubject}`,
      { headers: { authorization: `Bearer ${b.token}` } }))).status).toBe(403);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(observed.observation)} rv:observationHead ${iri(observed.observationRevision)} } }`);
    expect((await view()).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(observed.observation)} rv:observationHead ${iri(observed.observationRevision)} } }`);

    const bookTitle = `Library book ${randomUUID()}`;
    const book = await activateMetadataWork(stack.env, { title: bookTitle,
      semanticTypes: ['https://schema.org/Book'],
      admission: stack.admission(person.agent, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(bookTitle, ['https://schema.org/Book'])) });
    if (!book.work || !book.mainVersion) throw new Error('Book was not created');
    const text = await stack.contribution(book.work, person.agent, 'en', 'Book text');
    const selection = { context: { kind: 'main-version-default' as const, id: book.mainVersion },
      work: book.work, contribution: text.contribution, publicationDecision: text.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: person.agent };
    await selectMainDefault(stack.env, stack.admission(person.agent,
      `publication:select:${book.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
    await grant(`work:edit:${book.work}`, 'work.edit');
    await grant(`work:read:${book.work}`, 'work.read');
    const compositionResponse = await app.handle(new Request('http://main.local/v1/compositions', {
      method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'book-composition', work: book.work,
        mainVersion: book.mainVersion, actingSubject: person.agent }) }));
    expect(compositionResponse.status).toBe(201);
    const composition = await compositionResponse.json() as { structure: string; revision: string };
    const chapterResponse = await app.handle(new Request(
      `http://main.local/v1/works/${book.work.slice(-36)}/chapters`, { method: 'POST',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() },
        body: JSON.stringify({ profile: 'book-chapter-create-v1', title: 'Chapter One',
          language: 'en', direction: 'ltr', parent: composition.structure, position: 'last',
          expectedCompositionHead: composition.revision, actingSubject: person.agent }) }));
    expect(chapterResponse.status).toBe(200);
    const chapter = await chapterResponse.json() as { work: string };
    const bookRating = await app.handle(new Request('http://main.local/v1/global-rating-observations', {
      method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'global-rating-standing-observation-v1',
        context: context.context, work: book.work, mainVersion: book.mainVersion,
        expectedRevisionHead: null, value: 4, actingSubject: person.agent }) }));
    expect(bookRating.status).toBe(201);
    const occurrence = id();
    await new StructureProgressStore(stack.contentPool).write({ principal: a.principal,
      structure: composition.structure, occurrence, completed: false, position: 'paragraph-4',
      expectedVersion: 0, idempotencyKey: randomUUID() });
    const withProgress = await app.handle(new Request(
      `http://main.local/v1/works/${book.work.slice(-36)}/reader-state?actingSubject=${actingSubject}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(withProgress.status).toBe(200);
    expect(await withProgress.json()).toMatchObject({ rating: { global: { value: 4, availability: 'available' } },
      progress: { structure: composition.structure,
        occurrence, position: 'paragraph-4', completed: false, version: 1 } });
    const setBookStatus = (current: number, next: 'reading' | 'read') => app.handle(new Request(
      `http://main.local/v1/works/${book.work.slice(-36)}/reader-status`, { method: 'PUT',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() },
        body: JSON.stringify({ actingSubject: person.agent, expectedVersion: current,
          status: next, startedOn: null, finishedOn: null }) }));
    expect((await setBookStatus(0, 'reading')).status).toBe(200);
    const batchResponse = await app.handle(new Request(
      `http://main.local/v1/me/work-states?works=${encodeURIComponent(`${publicWork.work},${book.work}`)}`
        + `&actingSubject=${actingSubject}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(batchResponse.status).toBe(200);
    expect(await batchResponse.json()).toMatchObject({ items: [
      { work: publicWork.work, rating: { global: { value: 5 } },
        customShelves: [{ id: collection }] },
      { work: book.work, progress: { occurrence } },
    ] });
    const shelfWorksPath = `/v1/me/shelves/status/reading/works?actingSubject=${actingSubject}&limit=1`;
    const firstShelfPage = await app.handle(new Request(`http://main.local${shelfWorksPath}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(firstShelfPage.status).toBe(200);
    const page = await firstShelfPage.json() as { items: { work: string }[]; nextCursor: string };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const nextShelfPage = await app.handle(new Request(
      `http://main.local${shelfWorksPath}&cursor=${encodeURIComponent(page.nextCursor)}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(nextShelfPage.status).toBe(200);
    expect((await nextShelfPage.json() as { items: { work: string }[] }).items).toHaveLength(1);
    expect((await setBookStatus(1, 'read')).status).toBe(200);
    const staleShelfPage = await app.handle(new Request(
      `http://main.local${shelfWorksPath}&cursor=${encodeURIComponent(page.nextCursor)}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(staleShelfPage.status).toBe(409);
    const shelfPage = await app.handle(new Request(`http://main.local/v1/me/shelves?actingSubject=${actingSubject}&limit=1`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(shelfPage.status).toBe(200);
    const listed = await shelfPage.json() as { nextCursor: string; items: { id: string }[];
      statusShelves: { status: string; count: number }[] };
    expect(listed).toMatchObject({ statusShelves: expect.arrayContaining([
      expect.objectContaining({ status: 'reading', count: 1 })]),
      items: [expect.objectContaining({ id: collection, disclosure: 'private' })] });
    expect(listed.nextCursor).toBeTruthy();
    const olderPage = await app.handle(new Request(`http://main.local/v1/me/shelves?actingSubject=${actingSubject}`
      + `&limit=1&cursor=${encodeURIComponent(listed.nextCursor)}`,
    { headers: { authorization: `Bearer ${a.token}` } }));
    expect(olderPage.status).toBe(200);
    expect(await olderPage.json()).toMatchObject({ items: [{ id: olderCollection, disclosure: 'public' }],
      nextCursor: null });
    const chapterShelf = await app.handle(new Request(
      `http://main.local/v1/works/${chapter.work.slice(-36)}/reader-status`, { method: 'PUT',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() },
        body: JSON.stringify({ actingSubject: person.agent, expectedVersion: 2,
          status: 'want-to-read', startedOn: null, finishedOn: null }) }));
    expect(chapterShelf.status).toBe(200);
    expect(await chapterShelf.json()).toMatchObject({ work: book.work,
      status: 'want-to-read', version: 3 });
    expect((await status.batch(person.agent, [chapter.work, book.work])).map(row => row.status))
      .toEqual([null, 'want-to-read']);
    await status.write({ agent: person.agent, work: chapter.work, status: 'reading',
      startedOn: null, finishedOn: null, expectedVersion: 0, idempotencyKey: randomUUID() });
    await stack.contentPool.query("UPDATE reader.library_status SET title_key = '' WHERE agent = $1 AND work = $2",
      [person.agent, chapter.work]);
    await prepareLibraryShelves(stack.contentPool, stack.accessPool, stack.fuseki);
    const parentPrecedence = await app.handle(new Request(
      `http://main.local/v1/me/shelves?actingSubject=${actingSubject}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(await parentPrecedence.json()).toMatchObject({ statusShelves: expect.arrayContaining([
      expect.objectContaining({ status: 'want-to-read', count: 1 }),
      expect.objectContaining({ status: 'reading', count: 1 })]) });
    await status.write({ agent: person.agent, work: book.work, status: null,
      startedOn: null, finishedOn: null, expectedVersion: 3, idempotencyKey: randomUUID() });
    const legacyState = await app.handle(new Request(
      `http://main.local/v1/works/${chapter.work.slice(-36)}/reader-state?actingSubject=${actingSubject}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(legacyState.status).toBe(200);
    expect(await legacyState.json()).toMatchObject({ work: book.work,
      status: { work: book.work, status: null, version: 4 } });
    const legacyShelf = await app.handle(new Request(
      `http://main.local/v1/me/shelves/status/reading/works?actingSubject=${actingSubject}`,
      { headers: { authorization: `Bearer ${a.token}` } }));
    expect(legacyShelf.status).toBe(200);
    expect(await legacyShelf.json()).toMatchObject({ items: expect.not.arrayContaining([
      expect.objectContaining({ work: book.work })]) });
    await stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    try {
      expect((await visibilityRequest(a.token, { visibility: 'public', expectedVersion: 3 })).status).toBe(503);
    } finally {
      await stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    }
    expect(await (await app.handle(new Request(`http://main.local${visibilityPath}`,
      { headers: { authorization: `Bearer ${a.token}` } }))).json())
      .toMatchObject({ visibility: 'private', version: 3 });
    // Read after the next graph commit, before its admission seals the Access
    // inventory. The prior immutable rating remains usable and is marked stale.
    const command = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    let catchupRead = false;
    stack.fuseki.commandWithReceipt = async envelope => {
      const result = await command(envelope);
      if (result.status === 'committed' && envelope.update.includes('rv:GlobalRatingObservationRevision')) {
        catchupRead = true;
        const pending = await view();
        expect(pending.status).toBe(200);
        expect(await pending.json()).toMatchObject({ rating: { global: {
          value: 5, revision: observed.observationRevision, stale: true } } });
      }
      return result;
    };
    try {
      const updated = await app.handle(new Request('http://main.local/v1/global-rating-observations', {
        method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() },
        body: JSON.stringify({ profile: 'global-rating-standing-observation-v1',
          context: context.context, work: publicWork.work, mainVersion: publicWork.mainVersion,
          expectedRevisionHead: observed.observationRevision, value: 4, actingSubject: person.agent }) }));
      expect(updated.status).toBe(201);
      expect(catchupRead).toBe(true);
    } finally { stack.fuseki.commandWithReceipt = command; }
    expect(await (await view()).json()).toMatchObject({ rating: { global: { value: 4, stale: false } } });
    expect((await visibilityRequest(a.token, { visibility: 'public', expectedVersion: 3 })).status).toBe(200);
    const legacyPublic = await app.handle(new Request(`http://main.local${publicShelfPath}`));
    expect(legacyPublic.status).toBe(200);
    // Clearing the rewritten parent cannot resurrect the frozen chapter row.
    expect(await legacyPublic.json()).toMatchObject({ statusShelves: expect.arrayContaining([
      expect.objectContaining({ status: 'reading', count: 1 })]) });

    // G352: the same rated serial is a public discovery candidate; chapter Works
    // do not turn into separate cards or poison a first page with a 503.
    const basis = { scope: 'global' as const, realm: null, context: null };
    const operator = automaticDiscovery(null);
    const buildRequest = new Request('http://main.internal/library-discovery-build');
    let generation = await workRead(deps, buildRequest, {}, session =>
      discovery.register(operator, basis, session.position,
        { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) }));
    while (!generation.complete) {
      const previous = generation.checkpoint;
      generation = await workRead(deps, buildRequest, {}, async session => {
        const row = generation;
        const lease = await discovery.beginStep(operator, row.generation_id, row.checkpoint);
        return { ...await discovery.commitBatch(operator, row.generation_id, lease.lease, row.checkpoint,
          await projectDiscoveryBatch(session, basis, row.checkpoint), session.position), replayed: false };
      });
      expect(generation.complete || generation.checkpoint !== previous).toBe(true);
    }
    expect(generation.complete).toBe(true);
    await workRead(deps, buildRequest, {}, session => discovery.activate(operator,
      generation.generation_id, generation.active_head, session.position,
      { idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) }));
    const discover = () => app.handle(new Request('http://main.local/v1/works?limit=5'));
    const discoveryPage = await discover();
    expect(discoveryPage.status).toBe(200);
    const discovered = await discoveryPage.json() as { stale: boolean; items: { id: string }[] };
    expect(discovered.stale).toBe(false);
    expect(discovered.items.map(item => item.id)).toContain(book.work);
    expect(discovered.items.map(item => item.id)).not.toContain(chapter.work);
    await stack.privateWork(person.agent, 'Unrelated write after discovery');
    const retained = await discover();
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ stale: true, items: discovered.items });

    // Revoking Person control during rating hydration must discard the entire
    // response, including any owned rating already loaded from the inventory.
    const query = stack.fuseki.query.bind(stack.fuseki);
    await replacementController(stack.accessPool, person.agent);
    let revoked = false;
    stack.fuseki.query = async (sparql, bytes) => {
      const result = await query(sparql, bytes);
      if (!revoked && sparql.includes('SELECT ?availability ?value ?manifest ?currentHead')) {
        revoked = true;
        await stack.accessPool.query(`UPDATE access.representation SET active = false
          WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`,
        [a.principalId, person.agent]);
      }
      return result;
    };
    try {
      const revokedRead = await view();
      expect(revoked).toBe(true);
      expect(revokedRead.status).toBe(503);
      expect(await revokedRead.json()).toMatchObject({ code: 'work_read_unavailable' });
    } finally { stack.fuseki.query = query; }
    expect((await view()).status).toBe(403);
  } finally { await stack.stop(); }
}, 120_000);
