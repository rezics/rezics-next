import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ReadingPositionStore, RevelationConflict, propertyRevelationRecord, type Revelation }
  from '../../../services/main/src/modules/reading-position/store.ts';
import { ReadingBoundary, readReadingComposition, READING_POSITION_COST }
  from '../../../services/main/src/modules/reading-position/boundary.ts';
import { revelationReads } from '../../../services/main/src/modules/reading-position/read-registry.ts';
import { readResourceRelations } from '../../../services/main/src/modules/relation/traversal.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { SeriesSessionReader } from '../../../services/main/src/modules/session/series-store.ts';
import { readResourceSummaries } from '../../../services/main/src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { targetSummaryReader } from '../../../services/main/src/modules/target/resolve.ts';
import { workRead, WorkReadSession, WorkReadMoved } from '../../../services/main/src/modules/work/read-session.ts';
import { RV, activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { recordStatement, recordStatementRequest, setStatementDecision, statementDecisionRequest } from '../../../services/main/src/modules/statement/graph.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { startMediaStack } from './media-support.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const short = (resource: string) => resource.slice(-36);
type Composition = { structure: string; revision: string; occurrences: string[] };
type Changed = { component: string; revision: string; receipt: string };
async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status} (expected ${status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G847: real wiki reads withhold later records before delivery, counts and continuations; progress, corrections and 1000 chapters', async () => {
  const preparation = Date.now();
  const stack = await startMediaStack('g-847-position');
  try {
    const editor = await stack.member('position-reader'), outsider = await stack.member('other-reader');
    const library = new ReaderLibraryStatusStore(stack.contentPool);
    const store = new ReadingPositionStore(stack.contentPool);
    const objects = stack.objects('semantic/structure/'); await objects.initialize();
    let verifiedEmail = true;
    const deps: MainWorkDependencies = { environment: stack.env, access: stack.access,
      media: stack.media, mediaAccess: stack.mediaAccess, readingPositions: store, structureObjects: objects,
      progress: new StructureProgressStore(stack.contentPool), libraryStatus: library,
      seriesSessions: new SeriesSessionReader(stack.contentPool), sessions: new ConsumptionSessionStore(stack.contentPool, library),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = [editor, outsider].find(member => member.token === token);
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        return { ...member.principal, emailVerified: verifiedEmail,
          currentAssertion: async () => ({ ...member.principal, emailVerified: verifiedEmail }) };
      } } };
    const app = createMainApp(stack.fuseki, deps);
    const call = (method: string, path: string, body?: object, token = editor.token) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const person = (await json<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Wiki reader' }), 201)).agent;
    const organization = (await json<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'organization', displayName: 'Wiki organization' }), 201)).agent;
    const grant = async (scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), editor.principalId, person, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), person, scope, action]);
    };
    const work = async (title: string) => {
      const semanticTypes = ['https://schema.org/Book'];
      const result = await activateMetadataWork(stack.env, { title, semanticTypes,
        admission: stack.admission(person, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
      const text = await stack.contribution(result.work, person, 'en', title);
      const selection = { context: { kind: 'main-version-default' as const, id: result.mainVersion }, work: result.work,
        contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: person };
      await selectMainDefault(stack.env, stack.admission(person, `publication:select:${result.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await grant(`work:read:${result.work}`, 'work.read'); await grant(`work:edit:${result.work}`, 'work.edit');
      return result;
    };
    const series = await work('G847 Continuity'), volume1 = await work('Volume one'), volume2 = await work('Volume two');
    let seriesComposition = await json<Composition>(await call('POST', '/v1/compositions', {
      profile: 'work-composition', work: series.work, mainVersion: series.mainVersion, actingSubject: person }), 201);
    seriesComposition = await json<Composition>(await call('POST', `/v1/compositions/${short(seriesComposition.structure)}/changes`, {
      profile: 'work-composition', expectedHead: seriesComposition.revision, actingSubject: person,
      operations: [volume1, volume2].map((volume, index) => ({ op: 'insert', role: 'part', parent: seriesComposition.structure,
        position: 'last', target: volume.work, displayLabel: String(index + 1), inclusion: 'required' })) }));
    const chapters = async (volume: typeof volume1) => {
      const base = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'book-composition',
        work: volume.work, mainVersion: volume.mainVersion, actingSubject: person }), 201);
      return json<Composition>(await call('POST', `/v1/compositions/${short(base.structure)}/changes`, {
        profile: 'book-composition', expectedHead: base.revision, actingSubject: person,
        operations: [1, 2, 3].map(index => ({ op: 'insert', role: 'chapter', parent: base.structure, position: 'last',
          target: 'https://schema.org/DigitalDocument', label: { value: `Chapter ${index}`, language: 'en' } })) }));
    };
    let firstBook = await chapters(volume1); const secondBook = await chapters(volume2);
    const earlyPosition = firstBook.occurrences[1]!, readerPosition = firstBook.occurrences[2]!, latePosition = secondBook.occurrences[0]!;
    await grant('semantic:create:root', 'semantic.change');
    const name = (value: string, language = 'en') => ({ predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: value, language } });
    const alias = { predicate: 'https://schema.org/alternateName', value: { kind: 'language-string', lexical: 'Late true identity', language: 'en' } };
    const lateName = name('Later Japanese name', 'ja');
    const entity = async (label: string, extra: object[] = []) => {
      const result = await json<Changed>(await call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1', expectedHead: null, actingSubject: person,
        state: { component: 'resource', types: [`${RV}Character`], properties: [name(label), ...extra,
          { predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: series.work } }] } }), 201);
      await grant(`semantic:read:${result.component}`, 'semantic.read');
      return result;
    };
    const early = await entity('Early character', [alias, lateName]), unchanged = await entity('Catalogue character'), late = await entity('Late character');
    await grant(`statement:speak:${person}`, 'statement.record'); await grant('classification:decide:global', 'statement.decide');
    await ensureGlobalClassificationContext(stack.env);
    const statement = async (text: string) => {
      const input = { speaker: { kind: 'personal' as const }, subject: early.component,
        predicate: 'https://example.org/plotFact', relationDefinition: 'https://example.org/definition',
        value: { kind: 'literal' as const, lexical: text, language: null, datatype: 'http://www.w3.org/2001/XMLSchema#string' },
        applicability: [], interpretation: { kind: 'selected' as const }, evidence: [], actingSubject: person };
      const request = recordStatementRequest(input);
      const saved = await recordStatement(stack.env, stack.admission(person, request.scope, request.action, request.digest), input,
        { kind: 'personal', canReadPrivate: async () => false });
      const decision = { target: { kind: 'statement' as const, statement: saved.component! }, acceptance: { kind: 'global' as const },
        expectedDecisionHead: null, outcome: 'accepted' as const, actingSubject: person };
      const decide = statementDecisionRequest(decision);
      await setStatementDecision(stack.env, stack.admission(person, decide.scope, decide.action, decide.digest), decision);
      return { statement: saved.component!, receipt: saved.receipt };
    };
    const earlyFact = await statement('Early fact'), lateFact = await statement('Late fact');
    const meaning = await json<Changed>(await call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: person,
      state: { component: 'definition', kind: 'relation', workSubjectRole: 'work',
        roles: ['work', 'character'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) } }), 201);
    await grant(`semantic:read:${meaning.component}`, 'semantic.read');
    const relation = async () => json<{ occurrence: string; receipt: string }>(await call('POST', '/v1/relations/changes', {
      profile: 'relation-change-v1', expectedHead: null, definition: meaning.revision, actingSubject: person,
      participations: [{ role: 'work', participant: { kind: 'resource', ref: series.work } },
        { role: 'character', participant: { kind: 'resource', ref: early.component } }], evidence: 'https://example.org/evidence' }), 201);
    const earlyRelation = await relation(), lateRelation = await relation();
    for (const relation of [earlyRelation, lateRelation]) await grant(`semantic:read:${relation.occurrence}`, 'semantic.read');
    const collection = native(); await grant(`collection:edit:${collection}`, 'collection.edit');
    await grant(`semantic:read:${collection}`, 'semantic.read');
    let members = await json<Composition>(await call('POST', '/v1/collections', {
      collection, name: 'Characters', disclosure: 'public', actingSubject: person }), 201);
    members = await json<Composition>(await call('POST', `/v1/collections/${short(collection)}/changes`, {
      expectedHead: members.revision, actingSubject: person,
      operations: [early, unchanged, late].map(item => ({ op: 'insert', role: 'member', parent: members.structure,
        position: 'last', target: item.component, selection: { mode: 'follow-context' } })) }));
    await editor.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(await editor.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
      name: 'G847 Wiki', capabilities: ['realm'], actingSubject: editor.actor }), 201);
    const zone = native(); await editor.grant(`zone:edit:${zone}`, 'zone.edit');
    await editor.grant(`semantic:read:${collection}`, 'semantic.read');
    const zoned = await json<{ revision: string }>(await editor.send('POST', '/v1/zones', {
      zone, space: space.space, disclosure: 'public', actingSubject: editor.actor }), 201);
    await json(await editor.send('POST', `/v1/zones/${short(zone)}/mounts`, { expectedHead: zoned.revision,
      collection, routeSegment: 'characters', disclosure: 'public', position: 'last', actingSubject: editor.actor }));

    const reveal = async (record: string, recordKind: Revelation['recordKind'], occurrence: string,
      receipt = 'reviewed-publication', continuityWork = series.work) => {
      const client = await stack.contentPool.connect();
      try {
        await client.query('BEGIN');
        await store.write(client, { record, recordKind, continuityWork, occurrence, receipt }, null);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    await reveal(early.component, 'entity', earlyPosition); await reveal(late.component, 'entity', latePosition);
    await reveal(earlyFact.statement, 'statement', earlyPosition); await reveal(lateFact.statement, 'statement', latePosition);
    await reveal(earlyRelation.occurrence, 'relation', earlyPosition); await reveal(lateRelation.occurrence, 'relation', latePosition);
    await reveal(propertyRevelationRecord(early.component, alias.predicate, alias.value), 'alias', latePosition);
    await reveal(propertyRevelationRecord(early.component, lateName.predicate, lateName.value), 'name', latePosition);
    await reveal(early.component, 'entity', latePosition, 'alternate-continuity', volume2.work);
    expect((await store.lookup([early.component])).get(early.component)).toHaveLength(2);
    const privateContinuity = await activateMetadataWork(stack.env, { title: 'Private continuity', semanticTypes: ['https://schema.org/Book'],
      admission: stack.admission(person, 'work:create:root', 'work.create', metadataWorkRequestDigest('Private continuity', ['https://schema.org/Book'])) });
    await reveal(lateFact.statement, 'statement', earlyPosition, 'private-continuity', privateContinuity.work);
    const progress = (completed: boolean, version: number) => call('PUT',
      `/v1/compositions/${short(firstBook.structure)}/occurrences/${short(readerPosition)}/progress`,
      { actingSubject: person, expectedVersion: version, completed, position: null });
    await json(await progress(true, 0));
    expect(Date.now() - preparation).toBeLessThan(600_000);
    const read = (path: string, position?: string, signed = true) => call('GET', `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({
      ...(signed ? { actingSubject: person } : {}), ...(position ? { position } : {}) })}`, undefined, signed ? editor.token : '');
    const entityPath = (resource: string) => `/v1/resources/${short(resource)}/page`;
    const memberPath = `/v1/collections/${short(collection)}`;
    const zonePath = `/v1/zones/${short(zone)}/routes?path=${encodeURIComponent('/characters')}`;
    const statementPath = `/v1/resources/${short(early.component)}/statements`;
    const relationPath = `/v1/resources/${short(series.work)}/relations`;
    const exercised = new Set<string>();
    for (const [signed, position, expected] of [[false, undefined, [unchanged.component]],
      [true, undefined, [early.component, unchanged.component]], [false, readerPosition, [early.component, unchanged.component]],
      [false, 'all', [early.component, unchanged.component, late.component]], [true, 'all', [early.component, unchanged.component, late.component]]] as const) {
      const page = await json<{ occurrences: { target: string }[]; next: string | null }>(await read(memberPath, position, signed));
      expect(page.occurrences.map(item => item.target)).toEqual([...expected]); expect(page.next).toBeNull(); exercised.add('members');
      const retained = await json<typeof page>(await read(`${memberPath}/revisions/${short(members.revision)}`, position, signed));
      expect(retained.occurrences.map(item => item.target)).toEqual([...expected]); expect(retained.next).toBeNull(); exercised.add('retained-members');
      const index = await json<{ items: { id: string }[]; nextCursor: string | null }>(await read(zonePath, position, signed));
      expect(index.items.map(item => item.id)).toEqual([...expected]); expect(index.nextCursor).toBeNull(); exercised.add('zone');
      for (const item of [early, unchanged, late]) {
        const available = expected.includes(item.component);
        expect((await read(entityPath(item.component), position, signed)).status).toBe(available ? 200 : 404); exercised.add('entity');
        for (const [id, path] of [['semantic', `/v1/semantic/resources/${short(item.component)}`],
          ['retained-semantic', `/v1/semantic/resources/${short(item.component)}/revisions/${short(item.revision)}`]] as const) {
          const response = await read(path, position, signed);
          expect(response.status).toBe(available ? 200 : 404); exercised.add(id);
          if (available) expect(JSON.stringify(await response.json()).includes(alias.value.lexical)).toBe(item === early && position === 'all');
        }
        const detail = `/v1/zones/${short(zone)}/routes?path=${encodeURIComponent(`/characters/${short(item.component)}`)}`;
        expect((await read(detail, position, signed)).status).toBe(available ? 200 : 404);
      }
      if (signed || position) {
        const statements = await json<{ groups: { items: { kind: string; statement?: string; value: { lexical?: string } }[] }[];
          count: { value: number }; nextCursor: string | null }>(await read(statementPath, position, signed));
        const items = statements.groups.flatMap(group => group.items);
        expect(items.filter(item => item.kind === 'statement').map(item => item.statement)).toEqual(position === 'all'
          ? [earlyFact.statement, lateFact.statement].sort() : [earlyFact.statement]);
        expect(items.some(item => item.value.lexical === alias.value.lexical)).toBe(position === 'all');
        expect(statements.count.value).toBe(items.length); expect(statements.nextCursor).toBeNull(); exercised.add('statements');
        for (const fact of [earlyFact, lateFact]) {
          expect((await read(`/v1/statements/${short(fact.statement)}`, position, signed)).status)
            .toBe(fact === earlyFact || position === 'all' ? 200 : 404); exercised.add('statement');
        }
      }
      const relations = await json<{ items: { relation: string }[]; next: string | null }>(await read(relationPath, position, signed));
      expect(relations.items.map(item => item.relation)).toEqual(position === 'all'
        ? [earlyRelation.occurrence, lateRelation.occurrence].sort() : expected.includes(early.component) ? [earlyRelation.occurrence] : []);
      expect(relations.next).toBeNull(); exercised.add('relations');
      if (signed) {
        for (const relation of [earlyRelation, lateRelation]) {
          const path = `/v1/relations/${short(relation.occurrence)}`;
          const response = await read(path, position);
          expect(response.status).toBe(relation === earlyRelation || position === 'all' ? 200 : 404); exercised.add('relation');
          // The admitted write pins an exact retained occurrence revision.
          const current = await read(path, 'all');
          const revision = (await json<{ revision: string }>(current)).revision;
          expect((await read(`${path}/revisions/${short(revision)}`, position)).status)
            .toBe(relation === earlyRelation || position === 'all' ? 200 : 404); exercised.add('retained-relation');
        }
      }
    }
    expect([...exercised].sort()).toEqual(revelationReads.map(item => item.id).sort());
    await workRead(deps, new Request('http://main.local/v1/fixture'), {}, async session => {
      const page = await readResourceRelations(stack.env, { resource: series.work, languages: ['en'], limit: 20,
        canRead: async reference => reference !== meaning.component, canReadOccurrence: async () => false,
        visibleRecords: async records => {
          // An inaccessible definition withholds its occurrences before their
          // revelation positions can affect this page (including errors).
          expect(records).not.toContain(earlyRelation.occurrence);
          expect(records).not.toContain(lateRelation.occurrence);
          return new Set(records);
        },
        summarize: async resources => (await readResourceSummaries(stack.env, stack.media.store, targetSummaryReader(session),
          { resources, context: DEFAULT_MEDIA_CONTEXT, language: null })).summaries });
      expect(page.items).toEqual([]); expect(page.next).toBeNull();
    });
    const missingDetail = await read(`/v1/zones/${short(zone)}/routes?path=${encodeURIComponent(`/characters/${short(native())}`)}`, undefined, false);
    const hiddenDetail = await read(`/v1/zones/${short(zone)}/routes?path=${encodeURIComponent(`/characters/${short(late.component)}`)}`, undefined, false);
    expect(await hiddenDetail.json()).toEqual(await missingDetail.json());
    const visiblePage = await json<{ summary: { name: { value: string } } }>(await read(entityPath(early.component)));
    expect(visiblePage.summary.name.value).toBe('Early character');
    const namePage = await json<typeof visiblePage>(await read(`${entityPath(early.component)}?language=ja`));
    expect(namePage.summary.name.value).toBe('Early character');
    const fullNamePage = await json<typeof visiblePage>(await read(`${entityPath(early.component)}?language=ja`, 'all', false));
    expect(fullNamePage.summary.name.value).toBe(lateName.value.lexical);
    const narrowed = await json<{ occurrences: { target: string }[]; next: string | null }>(await read(`${memberPath}?limit=1`));
    expect(narrowed.occurrences.map(item => item.target)).toEqual([early.component]); expect(narrowed.next).toBeString();
    const tail = await json<typeof narrowed>(await read(`${memberPath}?limit=1&after=${encodeURIComponent(narrowed.next!)}`));
    expect(tail.occurrences.map(item => item.target)).toEqual([unchanged.component]); expect(tail.next).toBeNull();
    expect((await read(`${memberPath}?after=${encodeURIComponent(narrowed.next!)}`, 'all')).status).toBe(400);
    const factsFirst = await json<{ nextCursor: string | null; count: { value: number } }>(await read(`${statementPath}?limit=1`));
    expect(factsFirst.count.value).toBe(1); expect(factsFirst.nextCursor).toBeString();
    expect((await read(`${statementPath}?cursor=${encodeURIComponent(factsFirst.nextCursor!)}`, 'all')).status).toBe(400);
    const relationsFirst = await json<{ items: { relation: string }[]; next: string | null }>(await read(`${relationPath}?limit=1`, 'all'));
    expect(relationsFirst.items).toHaveLength(1); expect(relationsFirst.next).toBeString();
    const relationsTail = await json<typeof relationsFirst>(await read(`${relationPath}?limit=1&after=${encodeURIComponent(relationsFirst.next!)}`, 'all'));
    expect([...relationsFirst.items, ...relationsTail.items].map(item => item.relation)).toEqual([earlyRelation.occurrence, lateRelation.occurrence].sort());
    expect(relationsTail.next).toBeNull();
    expect((await read(`${relationPath}?after=${encodeURIComponent(relationsFirst.next!)}`, 'all', false)).status).toBe(400);
    const outsideContinuity = native();
    for (const path of [memberPath, `${memberPath}/revisions/${short(members.revision)}`]) {
      const outside = await json<{ occurrences: { target: string }[]; next: string | null }>(await read(path, outsideContinuity, false));
      expect(outside.occurrences.map(item => item.target)).toEqual([unchanged.component]); expect(outside.next).toBeNull();
    }
    expect((await json<{ items: unknown[] }>(await read(relationPath, outsideContinuity, false))).items).toEqual([]);
    const chooser = await json<{ resolved: string; items: { occurrence: string }[]; next: string | null }>(await read(`/v1/reading-positions/${short(series.work)}?limit=2`));
    expect(chooser.resolved).toBe(readerPosition); expect(chooser.items).toHaveLength(2); expect(chooser.next).toBeString();
    expect((await json<{ resolved: string }>(await read(`/v1/reading-positions/${short(series.work)}`, native()))).resolved).toBe('start');
    expect((await read(entityPath(early.component), 'bogus')).status).toBe(400);
    // The summary owner hook is exercised here; G-542 owns its HTTP transports.
    await workRead(deps, new Request('http://main.local/v1/fixture'), {}, async session => {
      const boundary = new ReadingBoundary(session);
      const summaries = await readResourceSummaries(stack.env, stack.media.store,
        { ...targetSummaryReader(session), visibleRecords: refs => boundary.visible(refs) },
        { resources: [early.component, unchanged.component, late.component], context: DEFAULT_MEDIA_CONTEXT, language: null });
      expect(summaries.summaries.map(item => item.status)).toEqual(['unavailable', 'available', 'unavailable']);
    });
    // Every fixture has an independently hidden item: removing its policy exposes
    // it, even when its references are already visible. This also guards the alias.
    const actualLookup = store.lookup.bind(store);
    store.lookup = async () => new Map();
    try {
      expect((await read(entityPath(late.component))).status).toBe(200);
      const leakedStatements = JSON.stringify(await json(await read(statementPath)));
      expect(leakedStatements).toContain(lateFact.statement); expect(leakedStatements).toContain(alias.value.lexical);
      expect(JSON.stringify(await json(await read(relationPath)))).toContain(lateRelation.occurrence);
      expect(JSON.stringify(await json(await read(memberPath)))).toContain(late.component);
      expect(JSON.stringify(await json(await read(`${memberPath}/revisions/${short(members.revision)}`)))).toContain(late.component);
      expect(JSON.stringify(await json(await read(zonePath)))).toContain(late.component);
      expect(JSON.stringify(await json(await read(`/v1/semantic/resources/${short(early.component)}`)))).toContain(alias.value.lexical);
      expect((await read(`/v1/statements/${short(lateFact.statement)}`)).status).toBe(200);
      expect((await read(`/v1/relations/${short(lateRelation.occurrence)}`)).status).toBe(200);
    } finally { store.lookup = actualLookup; }

    // Concurrent publications have one winner; exact replay is safe.
    const contested: Revelation = { record: native(), recordKind: 'entity', continuityWork: series.work,
      occurrence: earlyPosition, receipt: 'publication-a' };
    const writers = await Promise.all([stack.contentPool.connect(), stack.contentPool.connect()]);
    try {
      const attempts = await Promise.allSettled(writers.map((writer, index) =>
        store.write(writer, { ...contested, receipt: index ? 'publication-b' : contested.receipt }, null)));
      expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
      const rejected = attempts.find(attempt => attempt.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(RevelationConflict);
      const winner = (await store.lookup([contested.record])).get(contested.record)![0]!;
      await store.write(writers[0]!, winner, null);
      expect((await store.lookup([contested.record])).get(contested.record)).toEqual([winner]);
    } finally { writers.forEach(writer => writer.release()); }

    // Correction CAS, atomic rollback and generation fencing.
    const correction: Revelation = { record: early.component, recordKind: 'entity', continuityWork: series.work,
      occurrence: latePosition, receipt: 'reviewed-correction' };
    const client = await stack.contentPool.connect();
    try {
      await client.query('BEGIN');
      const absent = { ...correction, record: native() };
      await expect(store.write(client, absent, 'reviewed-publication')).rejects.toBeInstanceOf(RevelationConflict);
      expect((await store.lookup([absent.record])).size).toBe(0);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await expect(store.write(client, correction, 'wrong-receipt')).rejects.toBeInstanceOf(RevelationConflict);
      await client.query('ROLLBACK');
      await client.query('BEGIN'); await store.write(client, correction, 'reviewed-publication'); await client.query('ROLLBACK');
      expect((await store.lookup([early.component])).get(early.component)?.find(row => row.continuityWork === series.work)?.occurrence).toBe(earlyPosition);
      expect((await store.lookup([early.component])).get(early.component)?.find(row => row.continuityWork === volume2.work)?.receipt).toBe('alternate-continuity');
      await client.query('BEGIN'); await store.write(client, correction, 'reviewed-publication'); await client.query('COMMIT');
      expect((await read(entityPath(early.component))).status).toBe(404);
      expect((await read(`${memberPath}?after=${encodeURIComponent(narrowed.next!)}`)).status).toBe(400);
      await client.query('BEGIN'); await store.write(client, { ...correction, occurrence: earlyPosition, receipt: 'restored-correction' }, correction.receipt);
      await client.query('COMMIT');
    } finally { client.release(); }
    const session = new WorkReadSession(deps, new Request('http://main.local/v1/fixture'), {},
      { dataEpoch: stack.env.lineage.dataEpoch, sequence: '0' });
    const boundary = new ReadingBoundary(session, 'start'); await boundary.visible([early.component]);
    await stack.contentPool.query('UPDATE reading_position.generation SET version = version + 1 WHERE singleton');
    await expect(boundary.fence()).rejects.toBeInstanceOf(WorkReadMoved);
    // D2: G-835 treats Library "read" as finished, including Session projections.
    await json(await progress(false, 1));
    await json(await call('POST', '/v1/me/sessions', { actingSubject: person, target: firstBook.occurrences[0], expectedVersion: 0, state: 'finished' }), 201);
    expect((await read(entityPath(early.component))).status).toBe(200);
    await json(await progress(true, 2));
    expect((await read(entityPath(early.component))).status).toBe(200);
    expect((await read(`${memberPath}?after=${encodeURIComponent(narrowed.next!)}`)).status).toBe(400);
    const otherReader = await json<{ items: { id: string }[] }>(await call('GET', `${zonePath}&actingSubject=${encodeURIComponent(person)}`, undefined, outsider.token));
    expect(otherReader.items.map(item => item.id)).toEqual([unchanged.component]);
    const privateSnapshot = store.privateSnapshot.bind(store);
    let privateReads = 0;
    store.privateSnapshot = async (...args) => { privateReads++; return privateSnapshot(...args); };
    try {
      const organizationPage = await json<typeof otherReader>(await call('GET', `${zonePath}&actingSubject=${encodeURIComponent(organization)}`));
      expect(organizationPage.items.map(item => item.id)).toEqual([unchanged.component]);
      verifiedEmail = false;
      const unverifiedPage = await json<typeof otherReader>(await read(zonePath));
      expect(unverifiedPage.items.map(item => item.id)).toEqual([unchanged.component]);
      expect(privateReads).toBe(0);
    } finally { verifiedEmail = true; store.privateSnapshot = privateSnapshot; }
    // R3: pagination reads owner state without creating or advancing counters.
    const poolQuery = stack.contentPool.query.bind(stack.contentPool);
    const statements: string[] = [];
    stack.contentPool.query = ((...args: unknown[]) => {
      const query = args[0]; if (typeof query === 'string') statements.push(query);
      return (poolQuery as (...args: unknown[]) => unknown)(...args);
    }) as typeof stack.contentPool.query;
    try {
      expect((await read(`${memberPath}?limit=1`)).status).toBe(200);
      expect(statements.some(sql => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
    } finally { stack.contentPool.query = poolQuery; }
    const schema = await stack.contentPool.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'reading_position' ORDER BY tablename`);
    expect(schema.rows.map(row => row.name)).toEqual(['generation', 'revelation']);

    let baselineQueries = 0;
    await workRead(deps, new Request('http://main.local/v1/fixture'), {}, async session => {
      const before = stack.fuseki.queries;
      session.summaries = async () => { throw new Error('Boundary infrastructure must not recurse through request revelation summaries'); };
      expect((await readReadingComposition(session, series.work)).occurrences).toHaveLength(8);
      baselineQueries = stack.fuseki.queries - before;
    });
    for (let offset = 3; offset < 1000; offset += 16) {
      firstBook = await json<Composition>(await call('POST', `/v1/compositions/${short(firstBook.structure)}/changes`, {
        profile: 'book-composition', expectedHead: firstBook.revision, actingSubject: person,
        operations: Array.from({ length: Math.min(16, 1000 - offset) }, (_, index) => ({ op: 'insert', role: 'chapter',
          parent: firstBook.structure, position: 'last', target: 'https://schema.org/DigitalDocument',
          label: { value: `Chapter ${offset + index + 1}`, language: 'en' } })) }));
    }
    await workRead(deps, new Request('http://main.local/v1/fixture'), {}, async session => {
      const before = stack.fuseki.queries;
      const composition = await readReadingComposition(session, series.work);
      expect(composition.occurrences).toHaveLength(1005);
      expect(stack.fuseki.queries - before).toBe(baselineQueries);
      expect(composition.occurrences.length).toBeLessThan(READING_POSITION_COST.occurrences);
      expect(composition.occurrences.at(-3)?.occurrence).toBe(latePosition);
    });
  } finally { await stack.stop(); }
}, 600_000);
