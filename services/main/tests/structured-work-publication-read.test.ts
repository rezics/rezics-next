import { expect, test } from 'bun:test';
import { configureDisclosure, DISCLOSURE_COST, type DisclosureReader, type DisclosureTarget }
  from '../src/modules/disclosure/read.ts';
import { GRAPHS, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { admittedPublicWorks, PublishedStructureSourceUnavailable, readPublishedStructuredWorkSource,
  readPublishedStructuredWorkSources, readWorkPublicationParents,
  type PublishedStructuredWorkSource } from '../src/modules/work/public-patterns.ts';
import { structureRevisionDisclosureVisible } from '../src/modules/work/read-header.ts';
import { WorkReadSession, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { canReadCompositionWork } from '../src/modules/composition/disclosure-read.ts';
import { compositionReadRoutes } from '../src/routes/composition-reads.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { evaluatePublicationQueries, structuredWorkPublicationAnswer, structuredWorkSourceRow }
  from './structured-work-publication-fixture.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const main = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const decision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000005';
const generation = 'https://rezics.com/id/00000000-0000-4000-8000-000000000006';
const parent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000007';
const root = `urn:rezics:sha256:${'a'.repeat(64)}`;

const source: PublishedStructuredWorkSource = { work, mainVersion: main, structure,
  structureProfile: 'https://rezics.com/vocab/RecipeComposition', structureRevision: revision,
  decision, source: 'urn:rezics:work-source:publication', selectedGeneration: generation, sourceRoot: root };
const term = (value: string) => ({ value });
const sourceRow = (includeCandidate = false) => structuredWorkSourceRow(source, includeCandidate);

function env(query: (text: string, maxBytes?: number) => Promise<unknown>) {
  const environment = { fuseki: { query: async (text: string, maxBytes?: number) => {
    if (text.includes('SELECT ?resource ?head')) {
      const resources = [...(text.match(/VALUES \?resource \{([^}]+)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
        .map(match => match[1]!);
      return { results: { bindings: resources.map(resource => ({ resource: term(resource), head: term(main) })) } };
    }
    return query(text, maxBytes);
  } }, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/structured-work-publication-read' } as unknown as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(environment, target => target.work
    ? { resource: target.work, head: main, ...(target.workRevision !== undefined
      ? { protectedRevision: target.workRevision } : {}) } : undefined);
  return environment;
}

function publicationDataset(roots: readonly string[], options: {
  catalogue?: boolean; hidden?: boolean; absent?: boolean; ordinary?: boolean; manifests?: readonly string[];
} = {}): string {
  if (options.absent) return '';
  const values = (roots: readonly string[]) => roots.map(root => `<${root}>`).join(', ');
  return `@prefix rv: <https://rezics.com/vocab/> . @prefix schema: <https://schema.org/> .
    <${GRAPHS.current}> {
      <${work}> a schema:CreativeWork ; rv:mainVersion <${main}> .
      <${main}> a rv:MainVersion ; rv:work <${work}> .
      ${options.catalogue ? `<${work}> rv:catalogueVisible true .` : ''}
      ${options.ordinary ? '' : `<${work}> rv:workStructurePublicationHead <${decision}> .`}
      <${structure}> a rv:Structure ; rv:structureOf <${main}> ; rv:structureProfile <${source.structureProfile}> .
      <${generation}> a rv:StructureGeneration ; rv:structure <${structure}> .
    }
    ${options.ordinary ? '' : `<${GRAPHS.revisions}> {
      <${decision}> a rv:WorkStructurePublicationDecision ; rv:component <${work}> ;
        rv:publicationOutcome rv:Published ; rv:publicSource <${source.source}> ;
        rv:disclosure rv:${options.hidden ? 'Private' : 'Public'} ; rv:rightsBasis rv:OriginalContribution .
      <${source.source}> a rv:WorkStructurePublicSource ; rv:work <${work}> ; rv:component <${main}> ;
        rv:structureProfile <${source.structureProfile}> ; rv:structure <${structure}> ;
        rv:structureRevision <${revision}> ; rv:selectedGeneration <${generation}> .
      ${roots.length ? `<${source.source}> rv:sourceRoot ${values(roots)} .` : ''}
      <${revision}> a rv:StructureRevision ; rv:component <${structure}> ; rv:generation <${generation}> ;
        rv:manifest ${values(options.manifests ?? [root])} .
    }`}`;
}

test('WORK10/VIEW03: evaluated exact-source queries preserve malformed roots and private Composition equality', async () => {
  const queries: string[] = [];
  const captured = env(async query => { queries.push(query); return { results: { bindings: [] } }; });
  await readPublishedStructuredWorkSource(captured, work, main);
  await readPublishedStructuredWorkSources(captured, [work]);
  const dependencies = (environment: WorkActivationEnvironment, grant = async () => false) => ({ environment,
    access: { canReadWork: grant, assertRecoveryOpen: async () => undefined }, account: {},
  }) as unknown as MainWorkDependencies;
  const session = (deps: MainWorkDependencies) => new WorkReadSession(deps,
    new Request('http://main.test/v1/resources/example/parts'), {}, { dataEpoch: 'epoch', sequence: '1' });
  await canReadCompositionWork(session(dependencies(captured)), work);
  expect(queries).toHaveLength(3);
  const malformed = 'urn:rezics:sha256:malformed';
  const other = `urn:rezics:sha256:${'b'.repeat(64)}`;
  const cases = [
    { label: 'valid', dataset: publicationDataset([root]), result: 'valid', private: false },
    { label: 'malformed', dataset: publicationDataset([malformed], { catalogue: true }), result: 'incomplete', private: false },
    { label: 'valid beside malformed', dataset: publicationDataset([root, malformed]), result: 'ambiguous', private: false },
    { label: 'duplicate roots', dataset: publicationDataset([root, other], { manifests: [root, other] }), result: 'ambiguous', private: false },
    { label: 'absent', dataset: publicationDataset([], { absent: true }), result: 'absent', private: true },
    { label: 'ordinary private', dataset: publicationDataset([], { ordinary: true }), result: 'absent', private: true },
    { label: 'private zero roots', dataset: publicationDataset([]), result: 'incomplete', private: true },
    { label: 'private one malformed root', dataset: publicationDataset([malformed]), result: 'incomplete', private: true },
    { label: 'private two malformed roots', dataset: publicationDataset([malformed, `${malformed}-second`]), result: 'ambiguous', private: true },
    { label: 'hidden malformed root', dataset: publicationDataset([malformed], { hidden: true }), result: 'incomplete', private: true },
  ];
  const results = evaluatePublicationQueries(cases.flatMap(({ dataset }) => queries.map(query => ({ dataset, query }))));
  const responses = new Map<string, { status: number; headers: [string, string][]; body: string }>();
  for (const [index, item] of cases.entries()) {
    const environment = env(async query => {
      // The route's dataset fence is fixed; every publication and candidate
      // binding below comes from evaluating its generated SPARQL in Jena.
      if (query.includes('SELECT ?epoch ?sequence WHERE')) {
        return { results: { bindings: [{ epoch: term('epoch'), sequence: term('1') }] } };
      }
      const queryIndex = queries.indexOf(query);
      if (queryIndex < 0) throw new Error(`Unexpected semantic query: ${query}`);
      return results[index * queries.length + queryIndex]!;
    });
    if (item.result === 'valid') {
      expect(await readPublishedStructuredWorkSource(environment, work, main)).toEqual(source);
      expect(await readPublishedStructuredWorkSources(environment, [work])).toEqual(new Map([[work, source]]));
    } else if (item.result === 'absent') {
      expect(await readPublishedStructuredWorkSource(environment, work, main)).toBeNull();
      expect(await readPublishedStructuredWorkSources(environment, [work])).toEqual(new Map());
    } else {
      await expect(readPublishedStructuredWorkSource(environment, work, main)).rejects.toMatchObject({ reason: item.result });
      await expect(readPublishedStructuredWorkSources(environment, [work])).rejects.toMatchObject({ reason: item.result });
    }
    if (!item.private) continue;
    const deps = dependencies(environment, async () => { throw new Error('Anonymous reads must not seek a grant'); });
    const app = compositionReadRoutes(deps);
    for (const operation of ['parts', 'wholes']) {
      const response = await app.handle(new Request(`http://main.test/v1/resources/${work.slice(-36)}/${operation}`));
      const observed = { status: response.status, headers: [...response.headers], body: await response.text() };
      expect(observed.status).toBe(404);
      if (item.label === 'absent') responses.set(operation, observed);
      else expect(observed).toEqual(responses.get(operation)!);
    }
    if (item.result !== 'absent') {
      let grants = 0;
      for (const allowed of [false, true]) {
        const authorized = session(dependencies(environment, async () => { grants++; return allowed; }));
        authorized.principal = { issuer: 'account', subject: 'reader' };
        authorized.options.actingSubject = parent;
        if (!allowed) expect(await canReadCompositionWork(authorized, work)).toBe(false);
        else await expect(canReadCompositionWork(authorized, work)).rejects.toBeInstanceOf(
          item.result === 'ambiguous' ? WorkReadUnavailable : PublishedStructureSourceUnavailable);
      }
      expect(grants).toBe(2);
    }
  }
}, 120_000);

test('WORK10/COMP08: public Work reads resolve only the exact admitted Structure root', async () => {
  let queryText = '';
  const environment = env(async text => {
    queryText = text;
    return { results: { bindings: [sourceRow()] } };
  });
  expect(await readPublishedStructuredWorkSource(environment, work, main)).toEqual(source);
  expect(queryText).toContain('rv:manifest ?structuredRoot');
  expect(queryText).not.toContain('rv:structureHead');
  expect(queryText).not.toContain('rv:selectedGeneration ?currentGeneration');
});

test('WORK10/VIEW03: unpublished and withdrawn selections resolve as absent; duplicate roots fail closed', async () => {
  const unpublished = env(async () => ({ results: { bindings: [] } }));
  expect(await readPublishedStructuredWorkSource(unpublished, work, main)).toBeNull();
  const ambiguous = env(async () => ({ results: { bindings: [sourceRow(), sourceRow()] } }));
  await expect(readPublishedStructuredWorkSource(ambiguous, work, main)).rejects.toThrow('ambiguous');
});

test('WORK10/VIEW03: source reads distinguish absent publication from malformed and duplicate exact roots', async () => {
  for (const bindings of [[], [{ work: term(work) }], [{ work: term(work), main: term(main) }]]) {
    const environment = env(async () => ({ results: { bindings } }));
    expect(await readPublishedStructuredWorkSources(environment, [work])).toEqual(new Map());
    expect(await readPublishedStructuredWorkSource(environment, work, main)).toBeNull();
  }
  for (const malformed of [
    { structuredDecision: term(decision) },
    { ...sourceRow(true), structuredRoot: term('urn:rezics:sha256:malformed') },
    { ...sourceRow(true), structuredExact: term('false') },
    { ...sourceRow(true), main: term('urn:rezics:missing-main') },
  ]) {
    const environment = env(async query => {
      expect(query).toContain('OPTIONAL { ?structuredDecision rv:publicSource ?structuredSource');
      expect(query).toContain('BIND(EXISTS {');
      expect(query).toContain('AS ?structuredExact');
      return { results: { bindings: [{ work: term(work), ...malformed }] } };
    });
    await expect(readPublishedStructuredWorkSources(environment, [work]))
      .rejects.toBeInstanceOf(PublishedStructureSourceUnavailable);
    await expect(readPublishedStructuredWorkSources(environment, [work])).rejects.toMatchObject({ reason: 'incomplete' });
    // The scalar mainVersion is supplied by the caller; an invalid current
    // graph relation is represented by the owner's exact predicate.
    const scalar = env(async () => ({ results: { bindings: [{ ...malformed, structuredExact: term('false') }] } }));
    await expect(readPublishedStructuredWorkSource(scalar, work, main)).rejects.toMatchObject({ reason: 'incomplete' });
  }
  for (const secondRoot of [root, `urn:rezics:sha256:${'b'.repeat(64)}`, 'urn:rezics:sha256:malformed']) {
    const duplicate = [sourceRow(true), { ...sourceRow(true), structuredRoot: term(secondRoot) }];
    for (const bindings of [duplicate, [...duplicate].reverse()]) {
      const environment = env(async () => ({ results: { bindings } }));
      await expect(readPublishedStructuredWorkSource(environment, work, main)).rejects.toMatchObject({ reason: 'ambiguous' });
      // Two requested Works keep this below the row limit; duplicate detection
      // must also operate on Work keys, rather than only total row count.
      await expect(readPublishedStructuredWorkSources(environment, [work, parent])).rejects.toMatchObject({ reason: 'ambiguous' });
    }
  }
});

test('WORK10/VIEW03: exact-source batches keep published and ordinary Works in one bounded query', async () => {
  const candidates = Array.from({ length: 64 }, (_, index) =>
    `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`);
  const published = { ...source, work: candidates[0]! };
  let calls = 0;
  const environment = env(async (query, maxBytes) => {
    calls++;
    expect(maxBytes).toBe(128 * 1024);
    expect(query).toContain('LIMIT 65');
    return structuredWorkPublicationAnswer(query, [published]);
  });
  expect(await readPublishedStructuredWorkSources(environment, [...candidates, ...candidates]))
    .toEqual(new Map([[published.work, published]]));
  expect(calls).toBe(1);
  const ordinary = env(async query => {
    const publication = structuredWorkPublicationAnswer(query);
    if (publication) return publication;
    if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
      const batch = [...(query.match(/VALUES \?work \{([^}]+)\}/)?.[1] ?? '').matchAll(/<([^>]+)>/g)]
        .map(match => match[1]!);
      return { results: { bindings: batch.map(work => ({ work: term(work) })) } };
    }
    throw new Error(`Unexpected disclosure query: ${query}`);
  });
  configureDisclosure(ordinary, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  expect(await admittedPublicWorks(ordinary, candidates)).toEqual(new Set(candidates));
});

test('WORK10/VIEW03: public candidate admission requires the selected Structure disclosure at the same cut', async () => {
  let hiddenStructure = false;
  let hiddenParent = false;
  const environment = env(async text => {
    if (text.includes('SELECT ?work ?main ?structuredDecision')) {
      return { results: { bindings: [sourceRow(true)] } };
    }
    if (text.includes('SELECT ?work ?parent')) {
      return { results: { bindings: [{ work: term(work), parent: term(parent) }] } };
    }
    if (text.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
      return { results: { bindings: [{ work: term(work), head: term('https://rezics.com/id/00000000-0000-4000-8000-000000000007') }] } };
    }
    throw new Error(`Unexpected disclosure query: ${text}`);
  });
  const reader: DisclosureReader = { read: async targets => targets.map(target =>
    target.component === 'structure' && hiddenStructure
      || target.component === 'publication' && hiddenParent ? 'hidden' : 'visible') };
  configureDisclosure(environment, fixtureDisclosureReader(reader.read));

  expect(await admittedPublicWorks(environment, [work])).toEqual(new Set([work]));
  hiddenStructure = true;
  expect(await admittedPublicWorks(environment, [work])).toEqual(new Set());
  hiddenStructure = false;
  hiddenParent = true;
  expect(await admittedPublicWorks(environment, [work])).toEqual(new Set());
});

test('WORK10/VIEW03: parent admission stays bounded to one immediate parent per candidate across DISCLOSURE_COST batches', async () => {
  const candidates = Array.from({ length: DISCLOSURE_COST.batch + 1 }, (_, index) =>
    `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`);
  const parentQueries: Array<{ count: number; maxBytes: number | undefined }> = [];
  const disclosures: Array<readonly DisclosureTarget[]> = [];
  const environment = env(async (text, maxBytes) => {
    const batch = [...text.matchAll(/<https:\/\/rezics\.com\/id\/[0-9a-f-]{36}>/g)]
      .map(match => match[0].slice(1, -1));
    if (text.includes('SELECT ?work ?main ?structuredDecision')) {
      return { results: { bindings: batch.map(candidate => ({ ...sourceRow(true), work: term(candidate) })) } };
    }
    if (text.includes('SELECT ?work ?parent')) {
      parentQueries.push({ count: batch.length, maxBytes });
      expect(text).toContain(`LIMIT ${batch.length + 1}`);
      expect(text).not.toContain('schema:isPartOf+');
      expect(text).not.toContain('schema:isPartOf*');
      return { results: { bindings: batch.map(candidate => ({ work: term(candidate), parent: term(parent) })) } };
    }
    if (text.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
      return { results: { bindings: [...new Set(batch)].map(candidate => ({ work: term(candidate) })) } };
    }
    throw new Error(`Unexpected disclosure query: ${text}`);
  });
  configureDisclosure(environment, fixtureDisclosureReader(async targets => {
    disclosures.push(targets);
    return targets.map(() => 'visible');
  }));
  expect(await admittedPublicWorks(environment, [...candidates, ...candidates])).toEqual(new Set(candidates));
  const worksPerBatch = Math.floor(DISCLOSURE_COST.batch / 3);
  expect(parentQueries.map(query => query.count)).toEqual([worksPerBatch, worksPerBatch, worksPerBatch, 2]);
  expect(parentQueries.every(query => query.maxBytes === 32 * 1024)).toBe(true);
  expect(disclosures.every(batch => batch.length <= DISCLOSURE_COST.batch)).toBe(true);
  expect(disclosures.flat().filter(target => target.component === 'publication')).toHaveLength(candidates.length);
  disclosures.forEach(batch => {
    const names = batch.filter(target => target.component === 'name');
    expect(batch.filter(target => target.component === 'structure')).toHaveLength(names.length);
    expect(batch.filter(target => target.component === 'publication')).toHaveLength(names.length);
  });
});

test.each([
  ['missing row', []],
  ['ambiguous parents', [{ work: term(work), parent: term(parent) }, { work: term(work), parent: term(main) }]],
  ['missing Work key', [{ parent: term(parent) }]],
  ['foreign Work key', [{ work: term(main), parent: term(parent) }]],
  ['malformed parent', [{ work: term(work), parent: term('urn:rezics:private-container') }]],
  ['self parent', [{ work: term(work), parent: term(work) }]],
] as const)('VIEW03: malformed or ambiguous immediate parent batches fail closed: %s', async (_label, bindings) => {
  const environment = env(async () => ({ results: { bindings } }));
  await expect(readWorkPublicationParents(environment, [work])).rejects.toThrow('Publication parent batch');
});

test('VIEW03: invalid immediate parent requests fail closed before querying the owner', async () => {
  let queries = 0;
  const environment = env(async () => { queries++; return { results: { bindings: [] } }; });
  await expect(readWorkPublicationParents(environment, ['urn:rezics:private-container']))
    .rejects.toThrow('Publication parent batch is invalid');
  const oversized = Array.from({ length: DISCLOSURE_COST.batch + 1 }, (_, index) =>
    `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`);
  await expect(readWorkPublicationParents(environment, oversized)).rejects.toThrow('Publication parent batch is invalid');
  expect(queries).toBe(0);
});

test('WORK10/VIEW03: Structure disclosure is fenced on the exact admitted revision and owning Work', async () => {
  let visible = true;
  let seen: unknown;
  const session = { deps: { environment: undefined }, disclosure: async (targets: readonly unknown[]) => {
    seen = targets;
    return targets.map(target => JSON.stringify(target).includes(structure)
      ? visible ? 'visible' : 'hidden' : 'visible');
  } };
  const target = { work, workRevision: main, structure, revision };
  expect(await structureRevisionDisclosureVisible(session as never, target)).toBe(true);
  expect(seen).toEqual([
    { owner: 'graph', resource: work, component: 'name', work, workRevision: main },
    { owner: 'graph', resource: structure, component: 'structure', revision, work, workRevision: main },
  ]);
  visible = false;
  expect(await structureRevisionDisclosureVisible(session as never, target)).toBe(false);
});
