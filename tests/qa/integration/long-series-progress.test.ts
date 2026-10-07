import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { backfillOccurrenceLabels } from '../../../services/main/src/modules/structure/label-index-backfill.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';

const short = (resource: string) => resource.slice(-36);
type Composition = { structure: string; revision: string };
type Changed = { revision: string; occurrences: string[] };
type Chooser = { resolved: string; items: Array<{ occurrence: string; ordinal: number; parent: string; target: string | null }>; complete: boolean };
type Completed = { items: Array<{ occurrence: string; selectedRevision: string | null; completed: boolean }>;
  nextCursor: string | null; complete: boolean; consistency: string; count: { kind: string; total: null } };
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('a thousand admitted Episode occurrences seek, tick out of order and resume on another device', async () => {
  const started = Date.now();
  const stack = await startMediaStack('long-series-progress');
  try {
    const editor = await stack.member('series-reader'), outsider = await stack.member('other-series-reader');
    const originalObjects = stack.objects('semantic/structure/');
    await originalObjects.initialize();
    let objectReads = 0, graphRows = 0;
    const objects = { put: originalObjects.put.bind(originalObjects), get: async (digest: string) => {
      objectReads++;
      return originalObjects.get(digest);
    } };
    const queryGraph = stack.fuseki.query.bind(stack.fuseki);
    stack.fuseki.query = async (sparql, bytes) => {
      const value = await queryGraph(sparql, bytes);
      if (!stack.fuseki.isBackgroundContext) graphRows += value.results?.bindings.length ?? 0;
      return value;
    };
    const store = new StructureProgressStore(stack.contentPool);
    const device = () => createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      media: stack.media, mediaAccess: stack.mediaAccess, structureObjects: objects,
      progress: store,
      readingPositions: new ReadingPositionStore(stack.contentPool),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      account: { verify: async request => {
        const member = [editor, outsider].find(value => request.headers.get('authorization') === `Bearer ${value.token}`);
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        const principal = { ...member.principal, emailVerified: true };
        return { ...principal, currentAssertion: async () => principal };
      } } });
    const first = device(), second = device();
    const call = (app: ReturnType<typeof device>, method: string, path: string, body?: object,
      token: string | null = editor.token, key = randomUUID()) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const person = (await json<{ agent: string }>(await call(first, 'POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Returning viewer' }), 201)).agent;
    const grant = async (scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), editor.principalId, person, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), person, scope, action]);
    };
    const title = 'Thousand episode continuity', semanticTypes = ['https://schema.org/TVSeries'];
    const series = await activateMetadataWork(stack.env, { title, semanticTypes,
      admission: stack.admission(person, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
    const text = await stack.contribution(series.work, person, 'en', title);
    const selection = { context: { kind: 'main-version-default' as const, id: series.mainVersion }, work: series.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: person };
    await selectMainDefault(stack.env, stack.admission(person, `publication:select:${series.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection);
    await grant(`work:read:${series.work}`, 'work.read');
    await grant(`work:edit:${series.work}`, 'work.edit');
    await grant('semantic:create:root', 'semantic.change');
    const episode = async (number: number) => {
      const value = await json<{ component: string }>(await call(first, 'POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1', expectedHead: null, actingSubject: person,
        state: { component: 'resource', types: ['https://schema.org/Episode'], properties: [
          { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: `Episode ${number}`, language: 'en' } },
          { predicate: 'https://schema.org/episodeNumber', value: { kind: 'integer', lexical: String(number) } },
        ] } }), 201);
      await grant(`semantic:read:${value.component}`, 'semantic.read');
      return value.component;
    };
    // Accepted numbers differ from physical ranks and display labels. Reusing
    // the middle target measures occurrence inventory without 1000 admissions.
    const one = await episode(1), repeated = await episode(5000), thousand = await episode(1000), specialTarget = await episode(0);
    const composition = await json<Composition>(await call(first, 'POST', '/v1/compositions', {
      profile: 'work-composition', work: series.work, mainVersion: series.mainVersion, actingSubject: person }), 201);
    const path = `/v1/compositions/${short(composition.structure)}`;
    // Work compositions use the bounded change command; staged replacement is
    // currently a Book capability. Build this admitted fixture once in batches.
    const episodes: string[] = [];
    let revision = composition.revision;
    const change = async (operations: object[]) => {
      const value = await json<Changed>(await call(first, 'POST', `${path}/changes`, {
        profile: 'work-composition', expectedHead: revision, actingSubject: person, operations }));
      revision = value.revision;
      return value;
    };
    const groups = await change([
      { op: 'insert', role: 'group', parent: composition.structure,
        position: 'last', label: { value: 'Specials', language: 'en' } },
      { op: 'insert', role: 'group', parent: composition.structure,
        position: 'last', label: { value: 'Main episodes', language: 'en' } },
    ]);
    const specials = groups.occurrences[0]!, main = groups.occurrences[1]!;
    const special = (await change([{ op: 'insert', role: 'part', parent: specials,
      position: 'last', target: specialTarget, displayLabel: 'Special', inclusion: 'extra' }])).occurrences[0]!;
    for (let offset = 0; offset < 1000; offset += 16) {
      const page = await change(Array.from({ length: Math.min(16, 1000 - offset) }, (_, index) => ({
        op: 'insert', role: 'part', parent: main, position: 'last',
        target: offset + index === 0 ? one : offset + index === 999 ? thousand : repeated,
        displayLabel: `Episode ${offset + index + 1}`, inclusion: 'required' })));
      episodes.push(...page.occurrences);
    }
    await backfillOccurrenceLabels(stack.env);
    expect(Date.now() - started).toBeLessThan(600_000);
    const actorQuery = `actingSubject=${encodeURIComponent(person)}`;
    const chooser = `/v1/reading-positions/${short(series.work)}`;
    for (const [number, occurrence, target] of [[1, episodes[0]!, one], [1000, episodes[999]!, thousand]] as const) {
      const before = { rows: graphRows, reads: objectReads, calls: stack.fuseki.queries };
      const numbered = await json<Chooser>(await call(first, 'GET', `${chooser}?${actorQuery}&q=${number}&position=start&limit=1`));
      expect(numbered.items).toMatchObject([{ occurrence, ordinal: number, parent: main, target }]);
      expect(numbered.items).toHaveLength(1);
      expect(graphRows - before.rows).toBeLessThan(100);
      expect(objectReads - before.reads).toBeLessThan(40);
      expect(stack.fuseki.queries - before.calls).toBeLessThan(40);
    }
    const missingBefore = { rows: graphRows, reads: objectReads, calls: stack.fuseki.queries };
    expect(await json<Chooser>(await call(first, 'GET', `${chooser}?${actorQuery}&q=7&position=start&limit=1`)))
      .toMatchObject({ items: [], complete: true });
    expect(graphRows - missingBefore.rows).toBeLessThan(100);
    expect(objectReads - missingBefore.reads).toBeLessThan(40);
    expect(stack.fuseki.queries - missingBefore.calls).toBeLessThan(40);
    expect(await json(await call(first, 'GET', `${path}/occurrences/${short(episodes[6]!)}?${actorQuery}`)))
      .toMatchObject({ occurrences: [{ occurrence: episodes[6], parent: main, target: repeated }],
        });

    const tick = (occurrence: string, completed: boolean, expectedVersion = 0, key?: string) => call(first, 'PUT',
      `${path}/occurrences/${short(occurrence)}/progress`, { actingSubject: person,
        completed, expectedVersion, position: null }, editor.token, key);
    const retryKey = randomUUID();
    await json(await tick(episodes[999]!, true, 0, retryKey));
    expect(await json(await tick(episodes[999]!, true, 0, retryKey))).toMatchObject({ replayed: true, version: 1 });
    await json(await tick(episodes[6]!, true));
    expect((await tick(episodes[999]!, false, 0)).status).toBe(409);
    const resume = await json<Chooser>(await call(second, 'GET', `${chooser}?${actorQuery}&q=1000&position=mine&limit=1`));
    expect(resume.resolved).toBe(episodes[999]!);
    expect(await json(await call(second, 'GET', `${path}/occurrences/${short(episodes[999]!)}/progress?${actorQuery}`)))
      .toMatchObject({ completed: true, version: 1 });
    await json(await tick(special, true));
    expect((await json<Chooser>(await call(second, 'GET', `${chooser}?${actorQuery}&position=mine&limit=1&q=1000`))).resolved)
      .toBe(episodes[999]!);
    const separate = await json<Chooser>(await call(second, 'GET', `${chooser}?${actorQuery}&position=${encodeURIComponent(special)}&limit=1&q=1000`));
    expect(separate.resolved).toBe(special);
    expect(await json(await call(second, 'GET', `${path}?${actorQuery}&parent=${encodeURIComponent(specials)}&limit=1`)))
      .toMatchObject({ occurrences: [{ occurrence: special, parent: specials, target: specialTarget }] });
    const stillMain = await json<Chooser>(await call(second, 'GET', `${chooser}?${actorQuery}&q=1000&position=start&limit=1`));
    expect(stillMain.items[0]).toMatchObject({ occurrence: episodes[999], ordinal: 1000 });

    // Saved incomplete rows cannot turn a request bound into a series limit.
    await stack.contentPool.query(`INSERT INTO structure.progress
      (principal_issuer,principal_subject,structure,occurrence,selection_key,completed,position,version)
      SELECT $1,$2,$3,item,'',false,NULL,1 FROM unnest($4::text[]) AS item
      ON CONFLICT DO NOTHING`, [editor.principal.issuer, editor.principal.subject, composition.structure, episodes]);
    const completedPath = `${path}/progress?${actorQuery}&limit=17`;
    let cursor: string | null = null, pages = 0, emptyContinuations = 0;
    const ticks: string[] = [];
    do {
      const page: Completed = await json<Completed>(await call(second, 'GET', completedPath
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')));
      expect(page.consistency).toBe('live');
      expect(page.count).toMatchObject({ kind: 'exact-page', total: null });
      expect(page.items.every(item => item.completed)).toBe(true);
      ticks.push(...page.items.map(item => item.occurrence));
      if (!page.items.length && page.nextCursor) emptyContinuations++;
      cursor = page.nextCursor;
      expect(page.complete).toBe(cursor === null);
      expect(++pages).toBeLessThan(65);
    } while (cursor);
    expect(new Set(ticks)).toEqual(new Set([episodes[6]!, episodes[999]!, special]));
    expect(ticks).toHaveLength(3);
    expect(emptyContinuations).toBeGreaterThan(0);

    const initial = await json<Completed>(await call(second, 'GET', completedPath));
    expect(initial.nextCursor).not.toBeNull();
    expect((await call(second, 'GET', completedPath, undefined, null)).status).toBe(401);
    expect((await call(second, 'GET', completedPath + '&cursor=tampered')).status).toBe(400);
    expect((await call(second, 'GET', completedPath + `&cursor=${initial.nextCursor}`, undefined, outsider.token)).status).toBe(400);
    expect((await call(second, 'GET', completedPath.replace(short(composition.structure), randomUUID()))).status).toBe(404);
    expect(await json<Completed>(await call(second, 'GET', completedPath, undefined, outsider.token)))
      .toMatchObject({ items: [], nextCursor: null, complete: true });

    // A second-device edit is current on the next read; collections promise a
    // live view rather than a snapshot of earlier pages.
    await json(await tick(episodes[999]!, false, 1));
    const remaining = await json<Chooser>(await call(second, 'GET', `${chooser}?${actorQuery}&q=1000&position=mine&limit=1`));
    expect(remaining.resolved).toBe(episodes[6]!);
    await json(await tick(special, false, 1));
    await stack.contentPool.query(`UPDATE structure.progress SET completed = true, version = version + 1
      WHERE principal_issuer = $1 AND principal_subject = $2 AND structure = $3 AND occurrence = ANY($4::text[])`,
    [editor.principal.issuer, editor.principal.subject, composition.structure, episodes]);
    expect((await json<Chooser>(await call(second, 'GET', `${chooser}?${actorQuery}&q=1000&position=mine&limit=1`))).resolved)
      .toBe(episodes[999]!);

    const basis = await json<Completed>(await call(second, 'GET', completedPath));
    await json(await call(first, 'POST', `${path}/changes`, { profile: 'work-composition',
      expectedHead: (await json<{ revision: string }>(await call(first, 'GET', `${path}?${actorQuery}&limit=1`))).revision,
      actingSubject: person, operations: [{ op: 'remove', occurrence: episodes[0] }] }));
    expect((await call(second, 'GET', completedPath + `&cursor=${basis.nextCursor}`)).status).toBe(409);
    // A fresh owner-state page preserves this reader's saved tombstone key.
    expect(await store.read(editor.principal, composition.structure, episodes[0]!)).toMatchObject({ completed: true });
    await stack.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [editor.principalId]);
    expect((await call(second, 'GET', completedPath)).status).toBe(401);
  } finally { await stack.stop(); }
}, 600_000);
