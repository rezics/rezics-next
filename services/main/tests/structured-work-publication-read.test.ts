import { expect, test } from 'bun:test';
import { configureDisclosure, type DisclosureReader } from '../src/modules/disclosure/read.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { admittedPublicWorks, readPublishedStructuredWorkSource,
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

function env(query: (text: string) => Promise<unknown>) {
  return { fuseki: { query }, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/structured-work-publication-read' } as unknown as WorkActivationEnvironment;
}

test('public Work reads resolve only the exact admitted Structure root', async () => {
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

test('unpublished and withdrawn selections resolve as absent; duplicate roots fail closed', async () => {
  const unpublished = env(async () => ({ results: { bindings: [] } }));
  expect(await readPublishedStructuredWorkSource(unpublished, work, main)).toBeNull();
  const ambiguous = env(async () => ({ results: { bindings: [sourceRow(), sourceRow()] } }));
  await expect(readPublishedStructuredWorkSource(ambiguous, work, main)).rejects.toThrow('ambiguous');
});

test('public candidate admission requires the selected Structure disclosure at the same cut', async () => {
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

test('Structure disclosure is fenced on the exact admitted revision and owning Work', async () => {
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
