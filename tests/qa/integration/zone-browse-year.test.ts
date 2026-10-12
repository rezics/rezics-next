import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import {
  createRealmSpace,
  spaceCreationDigest,
} from '../../../services/main/src/modules/space/create.ts';
import { GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';
import { configureFixtureDisclosureAncestry } from '../../../services/main/tests/support/disclosure-ancestry.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
type Page = {
  items: { id: string }[];
  nextCursor: string | null;
  query: { publicationYear?: string };
  matches: { value: number; kind: string };
  facets: { type: { value: string; count: number }[] };
  window: { complete: boolean };
};

test('Zone year browse reaches member 300, qualified-fact support, and descending directory years', async () => {
  const stack = await startMediaStack('zone-browse-year');
  try {
    const actor = id(),
      input = { name: `Year browse ${randomUUID()}`, actingSubject: actor };
    const created = await createRealmSpace(
      stack.env,
      stack.admission(actor, 'space:create:root', 'space.create', spaceCreationDigest(input)),
      input,
    );
    if (created.outcome !== 'succeeded' || !created.realm) throw new Error('Realm creation failed');
    const realm = created.realm;
    // The graph, public hydration and HTTP contract are real. Only projection
    // order is deterministic here; its recovery has separate owner coverage.
    const works = Array.from({ length: 350 }, (_, index) => ({
      index,
      work: id(),
      main: id(),
      head: id(),
      slot: id(),
      selection: id(),
      contribution: id(),
      decision: id(),
      draft: id(),
      statement: id(),
      statementHead: id(),
      yearSlot: id(),
      yearDecision: id(),
      meaningKey: `urn:rezics:meaning:${String(index).padStart(64, '0')}`,
    }));
    for (let start = 0; start < works.length; start += 64) {
      const batch = works.slice(start, start + 64);
      await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${batch
          .map(
            (row) => `
          ${iri(row.work)} a schema:CreativeWork, schema:Book ; rv:mainVersion ${iri(row.main)} ;
            rv:head ${iri(row.head)} ; rdfs:label ${lit(`Year story ${row.index}`)}@en .
          ${row.index === 348 ? '' : `${iri(row.work)} rv:catalogueVisible true .`}
          ${iri(row.main)} a rv:MainVersion ; rv:work ${iri(row.work)} .
          ${iri(row.contribution)} rv:publicationHead ${iri(row.decision)} .
          ${iri(row.slot)} a rv:RealmResourceSlot ; rv:realm ${iri(realm)} ; rv:work ${iri(row.work)} ;
            rv:mainVersion ${iri(row.main)} ; rv:selectionHead ${iri(row.selection)} .
          ${
            row.index === 347
              ? ''
              : `${iri(row.statement)} a rdf:Statement ; rdf:subject ${iri(row.work)} ;
            rdf:predicate schema:datePublished ; rdf:object "${row.index < 300 ? '2001' : '1995'}"^^xsd:${row.index === 349 ? 'string' : 'gYear'} ;
            rv:meaningKey ${iri(row.meaningKey)} ;
            rv:statementState rv:${row.index === 346 ? 'Withdrawn' : 'Active'} ; rv:head ${iri(row.statementHead)} .
          ${iri(row.yearSlot)} a rv:DecisionSlot ; rv:decisionTarget ${iri(row.index === 300 ? row.meaningKey : row.statement)} ;
            rv:targetKind rv:${row.index === 300 ? 'QualifiedFactTarget' : 'StatementTarget'} ;
            rv:acceptanceContext <urn:rezics:classification-context:global> ; rv:decisionHead ${iri(row.yearDecision)} .`
          }`,
          )
          .join('\n')} }
        GRAPH ${iri(GRAPHS.revisions)} { ${batch
          .map(
            (row) => `
          ${iri(row.selection)} a rv:RealmSubmissionSelection ; rv:component ${iri(row.slot)} ; rv:context ${iri(realm)} ;
            rv:work ${iri(row.work)} ; rv:mainVersion ${iri(row.main)} ; rv:contribution ${iri(row.contribution)} ;
            rv:publicationDecision ${iri(row.decision)} ; rv:selectedDraft ${iri(row.draft)} ;
            rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ; rv:sequence ${row.index + 1} .
          ${iri(row.decision)} rv:disclosure rv:Public .
          ${iri(row.yearDecision)} a rv:StatementDecision ; rv:component ${iri(row.yearSlot)} ;
            rv:outcome rv:${row.index === 345 ? 'Rejected' : 'Accepted'} .
          ${row.index === 300 ? `${iri(row.yearDecision)} rv:support ${iri(row.statement)} .` : ''}`,
          )
          .join('\n')} } }`);
    }
    const duplicate = works[301]!,
      duplicateStatement = id(),
      duplicateSlot = id(),
      duplicateDecision = id();
    await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(duplicateStatement)} a rdf:Statement ; rdf:subject ${iri(duplicate.work)} ; rdf:predicate schema:datePublished ;
          rdf:object "1995-06-01"^^xsd:date ; rv:statementState rv:Active ; rv:head ${iri(id())} .
        ${iri(duplicateSlot)} a rv:DecisionSlot ; rv:decisionTarget ${iri(duplicateStatement)} ; rv:targetKind rv:StatementTarget ;
          rv:acceptanceContext <urn:rezics:classification-context:global> ; rv:decisionHead ${iri(duplicateDecision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(duplicateDecision)} a rv:StatementDecision ; rv:component ${iri(duplicateSlot)} ; rv:outcome rv:Accepted . } }`);
    const older = works[345]!,
      recentStatement = id(),
      recentSlot = id(),
      recentDecision = id();
    await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(recentStatement)} a rdf:Statement ; rdf:subject ${iri(older.work)} ; rdf:predicate schema:datePublished ;
          rdf:object "2024"^^xsd:gYear ; rv:statementState rv:Active ; rv:head ${iri(id())} .
        ${iri(recentSlot)} a rv:DecisionSlot ; rv:decisionTarget ${iri(recentStatement)} ; rv:targetKind rv:StatementTarget ;
          rv:acceptanceContext <urn:rezics:classification-context:global> ; rv:decisionHead ${iri(recentDecision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(recentDecision)} a rv:StatementDecision ; rv:component ${iri(recentSlot)} ; rv:outcome rv:Accepted . } }`);
    await stack.templateSeek.backfill(stack.env.lineage.dataEpoch, true);
    const entries = works.map((row) => ({
      work: row.work,
      adoptedOrder: String(350 - row.index),
      words: null,
      updatedAt: null,
    }));
    const projection = {
      current: async () => true,
      batch: async (
        _realm: string,
        _sort: string,
        after: { work: string; key: string | null } | null,
      ) =>
        entries
          .filter((entry) => !after || Number(entry.adoptedOrder) < Number(after.key))
          .slice(0, 64),
    };
    const app = createMainApp(stack.fuseki, {
      ...stack.composition.dependencies,
      zoneBrowse: projection as never,
      discovery: { active: async () => ({ stale: false }), workTerms: async () => [] } as never,
    });
    // These standalone catalogue Works have no Content ancestry. Retain the
    // real policy reader and declare their fixture-owned current Work heads.
    configureFixtureDisclosureAncestry(stack.env, (target) => {
      const row = works.find((row) => row.work === (target.work ?? target.resource));
      return row
        ? { resource: row.work, head: row.head, protectedRevision: target.workRevision }
        : undefined;
    });
    const path = `http://main.local/v1/realms/${realm.slice(-36)}/modules/browse`;
    const read = async (
      publicationYear: string,
      cursor?: string,
      publicationYearOrder?: 'descending',
    ) => {
      const query = new URLSearchParams({
        publicationYear,
        ...(cursor ? { cursor } : {}),
        ...(publicationYearOrder ? { publicationYearOrder } : {}),
      });
      const response = await app.handle(new Request(`${path}?${query}`));
      if (response.status !== 200) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json() as Promise<Page>;
    };
    const first = await read('1995');
    expect(first.query.publicationYear).toBe('1995');
    expect(first.items).toEqual([]);
    expect(first.matches).toEqual({ value: 0, kind: 'lower-bound' });
    expect(first.facets.type).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await read('1995', first.nextCursor!);
    expect(second.items.map((item) => item.id)).toEqual(
      works.slice(300, 320).map((row) => row.work),
    );
    expect(second.items[0]!.id).toBe(works[300]!.work);
    expect(second.matches).toEqual({ value: 20, kind: 'lower-bound' });
    expect(second.facets.type).toEqual([{ value: 'https://schema.org/Book', count: 20 }]);
    const third = await read('1995', second.nextCursor!);
    const last = await read('1995', third.nextCursor!);
    expect([...second.items, ...third.items, ...last.items].map((item) => item.id)).toEqual(
      works.slice(300, 345).map((row) => row.work),
    );
    expect(last.matches).toEqual({ value: 45, kind: 'exact' });
    expect(last.facets.type).toEqual([{ value: 'https://schema.org/Book', count: 5 }]);
    expect(last.nextCursor).toBeNull();
    expect(last.window.complete).toBe(true);
    const directory = await read('1-9999', undefined, 'descending');
    expect(directory.items[0]!.id).toBe(older.work);
    expect(directory.items[0]!.id).not.toBe(works[300]!.work);
    const changed = await app.handle(
      new Request(
        `${path}?${new URLSearchParams({
          publicationYear: '2001',
          cursor: first.nextCursor!,
        })}`,
      ),
    );
    expect(changed.status).toBe(400);
    expect((await read('1990-2000')).items.map((item) => item.id)).toEqual(
      first.items.map((item) => item.id),
    );
    const post = await app.handle(
      new Request('http://main.local/v1/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: 'filter-document-v2',
          context: { realm },
          scope: { kind: 'realm', realm },
          sort: 'newest',
          page: { size: 20 },
          filter: { all: [{ facet: 'publicationYear', range: { min: '01995', max: '1995' } }] },
        }),
      }),
    );
    if (post.status !== 200) throw new Error(`${post.status}: ${await post.text()}`);
    expect(((await post.json()) as { result: Page }).result.items.map((item) => item.id)).toEqual(
      first.items.map((item) => item.id),
    );
    for (const invalid of ['2000-1990', '10000', '1995) UNION {}']) {
      expect(
        (
          await app.handle(
            new Request(`${path}?${new URLSearchParams({ publicationYear: invalid })}`),
          )
        ).status,
      ).toBe(400);
    }
  } finally {
    await stack.stop();
  }
}, 120_000);
