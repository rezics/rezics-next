import { expect, test } from 'bun:test';
import { configureDisclosure, DISCLOSURE_COST, type DisclosureReader, type DisclosureTarget }
  from '../src/modules/disclosure/read.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { admittedPublicWorks, readPublishedStructuredWorkSource, readWorkPublicationParents,
  type PublishedStructuredWorkSource } from '../src/modules/work/public-patterns.ts';
import { structureRevisionDisclosureVisible } from '../src/modules/work/read-header.ts';

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
const sourceRow = (includeCandidate = false) => ({
  ...(includeCandidate ? { work: term(work), main: term(main) } : {}),
  structuredDecision: term(decision), structuredSource: term(source.source),
  structuredStructure: term(structure), structuredProfile: term(source.structureProfile),
  structuredRevision: term(revision), structuredGeneration: term(generation), structuredRoot: term(root),
});

function env(query: (text: string, maxBytes?: number) => Promise<unknown>) {
  return { fuseki: { query }, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/structured-work-publication-read' } as unknown as WorkActivationEnvironment;
}

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
  configureDisclosure(environment, reader);

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
  configureDisclosure(environment, { read: async targets => {
    disclosures.push(targets);
    return targets.map(() => 'visible');
  } });
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
