import { expect, test } from 'bun:test';
import { readRecipeHierarchyPage, RECIPE_WORK_PAGE_BYTES, RECIPE_WORK_PAGE_OCCURRENCES,
  RECIPE_WORK_PAGE_READ_BOUND } from '../src/modules/recipe/work-page.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { STRUCTURE_LIMITS, type OccurrenceRecord, type RecipeMeasure } from '../src/modules/structure/format.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';

if (!/^[0-9a-f]{64}$/.test(Bun.env.FUSEKI_MAINTENANCE_TOKEN ?? '')) {
  Bun.env.FUSEKI_MAINTENANCE_TOKEN = 'ab'.repeat(32);
}

const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000010';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
const otherRevision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000012';
const otherStructure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000013';

let sequence = 0;
const id = () => {
  sequence += 1;
  return `https://rezics.com/id/00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
};

const servingsMeasure = (numerator: number): RecipeMeasure => ({
  kind: 'servings', value: { numerator, denominator: 1 }, unitText: 'servings', basis: 'whole-recipe',
  coverage: 'complete', provenance: 'declared',
});
const nutrientMeasure: RecipeMeasure = {
  kind: 'nutrient', nutrient: 'https://example.test/energy', unit: 'https://example.test/kcal',
  value: { numerator: 80, denominator: 1 }, basis: 'per-serving', coverage: 'complete', provenance: 'computed',
};

function node(parent: string, order: number, role: OccurrenceRecord['role'],
  qualifier?: OccurrenceRecord['qualifier'], label?: string): OccurrenceRecord {
  return { occurrence: id(), state: 'active', parent, segmentKey: 's',
    orderKey: order.toString(36).padStart(4, '0'), role, labels: label ? [{ value: label, language: 'en' }] : [],
    introducedBy: revision, ...(qualifier ? { qualifier } : {}) };
}

function ingredient(parent: string, order: number, text: string, numerator = 1): OccurrenceRecord {
  return node(parent, order, 'ingredient', { type: 'ingredient-line', originalText: { value: text, language: 'en' },
    amountLexical: `${numerator}`, amount: { numerator, denominator: 1 }, unitText: 'cup', optional: false,
    scaling: 'linear', substituteFor: [], parseStatus: 'parsed' });
}

interface CallStats { parent: number; data: number; empty: number; limits: number[] }

function treeKey(record: OccurrenceRecord): string {
  if (!record.segmentKey || !record.orderKey) throw new Error('fixture occurrence has no order');
  return orderTreeKey({ parent: record.parent, segmentKey: record.segmentKey, orderKey: record.orderKey });
}

function fixture(records: readonly OccurrenceRecord[]) {
  const byParent = new Map<string, OccurrenceRecord[]>();
  for (const record of records) {
    const list = byParent.get(record.parent) ?? [];
    list.push(record);
    byParent.set(record.parent, list);
  }
  for (const list of byParent.values()) list.sort((left, right) => treeKey(left).localeCompare(treeKey(right)));
  const byId = new Map(records.map(record => [record.occurrence, record]));
  const stats: CallStats = { parent: 0, data: 0, empty: 0, limits: [] };
  const reset = () => { stats.parent = 0; stats.data = 0; stats.empty = 0; stats.limits = []; };
  return { stats, reset, records, async readChildren(query: { parent: string; after?: string; limit: number }) {
    stats.limits.push(query.limit);
    const siblings = byParent.get(query.parent) ?? [];
    let start = 0;
    if (query.after) {
      const anchor = siblings.findIndex(item => treeKey(item) === query.after);
      if (anchor < 0) throw new Error('fixture continuation is not a sibling');
      start = anchor + 1;
    }
    const occurrences = siblings.slice(start, start + query.limit);
    if (occurrences.length === 0) stats.empty += 1;
    else stats.data += 1;
    const next = start + occurrences.length < siblings.length && occurrences.length > 0
      ? treeKey(occurrences.at(-1)!) : null;
    return { occurrences, next, pagesRead: 1 };
  }, async readParent(occurrence: string) {
    stats.parent += 1;
    return { record: byId.get(occurrence) ?? null, pagesRead: 1 };
  } };
}

function depthFirst(records: readonly OccurrenceRecord[], root: string): OccurrenceRecord[] {
  const children = new Map<string, OccurrenceRecord[]>();
  for (const record of records) {
    const list = children.get(record.parent) ?? [];
    list.push(record);
    children.set(record.parent, list);
  }
  const walk = (parent: string): OccurrenceRecord[] => (children.get(parent) ?? [])
    .flatMap(record => [record, ...(record.role === 'group' ? walk(record.occurrence) : [])]);
  return walk(root);
}

async function walk(records: readonly OccurrenceRecord[], options?: { servings?: number; measures?: RecipeMeasure[] }) {
  const source = fixture(records);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const sizes: number[] = [];
  do {
    source.reset();
    let measureReads = 0;
    const page = await readRecipeHierarchyPage({ structure, revision, ...(cursor ? { cursor } : {}),
      ...(options?.servings !== undefined && !cursor ? { servings: options.servings } : {}),
      readMeasures: async () => {
        measureReads += 1;
        return { measures: options?.measures ?? [], pagesRead: 1 };
      },
      readChildren: source.readChildren, readParent: source.readParent });
    expect(page.profile).toBe('recipe-work-page-v1');
    if (page.profile !== 'recipe-work-page-v1') break;
    pages += 1;
    expect(page.occurrences.length).toBeGreaterThan(0);
    expect(page.occurrences.length).toBeLessThanOrEqual(RECIPE_WORK_PAGE_OCCURRENCES);
    expect(page.cost.occurrences).toBe(page.occurrences.length);
    expect(measureReads).toBe(1);
    expect(page.measures).toEqual(options?.measures ?? []);
    expect(page.cost.pages).toBe(source.stats.parent + source.stats.data + source.stats.empty + 1);
    expect(source.stats.data + source.stats.empty).toBeLessThanOrEqual(STRUCTURE_LIMITS.maxDepth + 1);
    expect(source.stats.parent).toBeLessThanOrEqual(STRUCTURE_LIMITS.maxDepth);
    expect(source.stats.empty).toBeLessThanOrEqual(STRUCTURE_LIMITS.maxDepth + 1);
    expect(page.cost.pages).toBeLessThanOrEqual(RECIPE_WORK_PAGE_READ_BOUND);
    expect(source.stats.limits.every(limit => limit === RECIPE_WORK_PAGE_OCCURRENCES)).toBe(true);
    sizes.push(page.occurrences.length);
    seen.push(...page.occurrences.map(item => item.occurrence));
    cursor = page.next;
  } while (cursor);
  return { seen, pages, sizes };
}

test('a nested recipe fills depth-first in one call', async () => {
  const sauce = node(structure, 1, 'group', undefined, 'Sauce');
  const tomato = ingredient(sauce.occurrence, 0, '1 cup tomato');
  const salt = ingredient(sauce.occurrence, 1, '1 cup salt');
  const flour = ingredient(structure, 0, '1 cup flour');
  const empty = node(structure, 2, 'group', undefined, 'Empty');
  const bake = node(structure, 3, 'step', { type: 'recipe-step',
    instructionText: { value: 'Bake.', language: 'en' }, usesIngredient: [], media: [], scaling: 'linear' });
  const records = [flour, sauce, tomato, salt, empty, bake];
  const source = fixture(records);
  const measures = [servingsMeasure(4), nutrientMeasure];
  const first = await readRecipeHierarchyPage({ structure, revision, servings: 8, measures,
    readChildren: source.readChildren, readParent: source.readParent });
  expect(first.profile).toBe('recipe-work-page-v1');
  if (first.profile !== 'recipe-work-page-v1') return;
  expect(first.occurrences.map(item => item.occurrence)).toEqual(depthFirst(records, structure)
    .map(item => item.occurrence));
  expect(first.occurrences.map(item => item.parent)).toEqual(depthFirst(records, structure).map(item => item.parent));
  expect(first.measures).toEqual(measures);
  expect(first.ingredients[0]).toMatchObject({ occurrence: flour.occurrence, amount: { numerator: 2, denominator: 1 },
    line: '2 cups flour', scaled: true });
  expect(first.next).toBeUndefined();
  expect(source.stats.data).toBeGreaterThan(1);
  const { seen, pages } = await walk(records, { servings: 8, measures });
  expect(seen).toEqual(depthFirst(records, structure).map(item => item.occurrence));
  expect(pages).toBe(1);
});

test('a missing cursor parent is refused and an empty group does not emit an empty page', async () => {
  const group = node(structure, 0, 'group', undefined, 'Sauce');
  const children = Array.from({ length: 120 }, (_, order) => ingredient(group.occurrence, order, '1 cup tomato'));
  const source = fixture([group, ...children]);
  const opened = await readRecipeHierarchyPage({ structure, revision, measures: [servingsMeasure(4)],
    readChildren: source.readChildren, readParent: source.readParent });
  expect(opened.profile === 'recipe-work-page-v1' && opened.next).toBeString();
  const cursor = opened.profile === 'recipe-work-page-v1' ? opened.next! : '';
  await expect(readRecipeHierarchyPage({ structure, revision, cursor,
    readChildren: source.readChildren,
    readParent: async () => ({ record: null, pagesRead: 1 }) })).rejects.toBeInstanceOf(WorkReadUnavailable);
  const { seen, pages } = await walk([
    ingredient(structure, 0, '1 cup flour'),
    node(structure, 1, 'group', undefined, 'Empty'),
    ingredient(structure, 2, '1 cup water'),
  ]);
  expect(seen).toHaveLength(3);
  expect(pages).toBe(1);
});

test('ten thousand nested occurrences are complete, ordered and bounded on every call', async () => {
  const records: OccurrenceRecord[] = [];
  for (let section = 0; section < 10; section += 1) {
    const outer = node(structure, section, 'group', undefined, `section ${section}`);
    records.push(outer);
    for (let sub = 0; sub < 10; sub += 1) {
      const inner = node(outer.occurrence, sub, 'group', undefined, `sub ${sub}`);
      records.push(inner);
      for (let item = 0; item < 99; item += 1) records.push(ingredient(inner.occurrence, item, '1 cup flour'));
    }
  }
  expect(records).toHaveLength(10_010);
  const { seen, pages, sizes } = await walk(records);
  expect(seen).toEqual(depthFirst(records, structure).map(item => item.occurrence));
  expect(pages).toBe(Math.ceil(records.length / RECIPE_WORK_PAGE_OCCURRENCES));
  expect(sizes.slice(0, -1).every(size => size === RECIPE_WORK_PAGE_OCCURRENCES)).toBe(true);
  expect(sizes.at(-1)).toBe(records.length % RECIPE_WORK_PAGE_OCCURRENCES);
  const flat = Array.from({ length: 250 }, (_, order) => ingredient(structure, order, '1 cup flour'));
  const paged = await walk(flat);
  expect(paged.seen).toEqual(flat.map(item => item.occurrence));
  expect(paged.pages).toBe(3);
});

test('a single page over 1 MiB is refused and more than 64 measures are refused', async () => {
  const fat = Array.from({ length: RECIPE_WORK_PAGE_OCCURRENCES }, (_, order) =>
    ingredient(structure, order, `1 cup ${'x'.repeat(12_000)}`));
  const source = fixture(fat);
  await expect(readRecipeHierarchyPage({ structure, revision, measures: [servingsMeasure(4)],
    readChildren: source.readChildren, readParent: source.readParent })).rejects.toBeInstanceOf(WorkReadLimit);
  expect(source.stats.data).toBe(1);
  const measures = Array.from({ length: STRUCTURE_LIMITS.measures + 1 }, () => nutrientMeasure);
  await expect(readRecipeHierarchyPage({ structure, revision, measures,
    readChildren: () => { throw new Error('measure bound is checked before the walk'); },
    readParent: () => { throw new Error('measure bound is checked before the walk'); } }))
    .rejects.toThrow('Recipe measures exceed 64');
  expect(RECIPE_WORK_PAGE_BYTES).toBe(1_048_576);
  expect(RECIPE_WORK_PAGE_READ_BOUND).toBe(2 * STRUCTURE_LIMITS.maxDepth + 2);
});

function step(parent: string, order: number, text: string): OccurrenceRecord {
  return node(parent, order, 'step', { type: 'recipe-step', instructionText: { value: text, language: 'en' },
    usesIngredient: [], media: [], scaling: 'linear' });
}

test('a two-section four-step recipe returns every occurrence in one call', async () => {
  const cake = node(structure, 0, 'group', undefined, 'Cake');
  const frosting = node(structure, 1, 'group', undefined, 'Frosting');
  const records = [cake, step(cake.occurrence, 0, 'Mix.'), step(cake.occurrence, 1, 'Bake.'),
    frosting, step(frosting.occurrence, 0, 'Spread.'), step(frosting.occurrence, 1, 'Serve.')];
  const source = fixture(records);
  const page = await readRecipeHierarchyPage({ structure, revision, measures: [servingsMeasure(4)],
    readChildren: source.readChildren, readParent: source.readParent });
  expect(page.profile).toBe('recipe-work-page-v1');
  if (page.profile !== 'recipe-work-page-v1') return;
  const ordered = depthFirst(records, structure);
  expect(page.occurrences.map(item => item.occurrence)).toEqual(ordered.map(item => item.occurrence));
  expect(page.occurrences.map(item => item.parent)).toEqual(ordered.map(item => item.parent));
  expect(page.occurrences.map(item => item.role)).toEqual(['group', 'step', 'step', 'group', 'step', 'step']);
  expect(page.next).toBeUndefined();
  expect(page.measures).toEqual([servingsMeasure(4)]);
  expect(source.stats.data).toBeGreaterThan(1);
  expect(source.stats.data + source.stats.empty).toBeLessThanOrEqual(STRUCTURE_LIMITS.maxDepth + 1);
  const walked = await walk(records);
  expect(walked.pages).toBe(1);
  expect(walked.seen).toEqual(ordered.map(item => item.occurrence));
});

test('a cursor resumes mid-section and pins servings, the mac and a stale revision', async () => {
  const section = node(structure, 0, 'group', undefined, 'Cake');
  const children = Array.from({ length: 150 }, (_, order) => ingredient(section.occurrence, order, `1 cup flour ${order}`));
  const salt = ingredient(structure, 1, '1 cup salt');
  const records = [section, ...children, salt];
  const source = fixture(records);
  const measures = [servingsMeasure(4), nutrientMeasure];
  const first = await readRecipeHierarchyPage({ structure, revision, servings: 8, measures,
    readChildren: source.readChildren, readParent: source.readParent });
  expect(first.profile).toBe('recipe-work-page-v1');
  if (first.profile !== 'recipe-work-page-v1') return;
  expect(first.occurrences).toHaveLength(RECIPE_WORK_PAGE_OCCURRENCES);
  expect(first.occurrences[0]?.occurrence).toBe(section.occurrence);
  expect(first.occurrences.at(-1)?.occurrence).toBe(children[98]?.occurrence);
  expect(first.occurrences.at(-1)?.parent).toBe(section.occurrence);
  expect(first.next).toBeString();
  const cursor = first.next!;
  source.reset();
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
  await expect(readRecipeHierarchyPage({ structure, revision, cursor: tampered, measures: [servingsMeasure(1)],
    readChildren: source.readChildren, readParent: source.readParent })).rejects.toBeInstanceOf(WorkReadInvalid);
  expect(source.stats.parent + source.stats.data + source.stats.empty).toBe(0);
  await expect(readRecipeHierarchyPage({ structure, revision, cursor, servings: 3,
    readChildren: source.readChildren, readParent: source.readParent })).rejects.toThrow(/pinned recipe page/);
  const stale = await readRecipeHierarchyPage({ structure, revision: otherRevision, cursor,
    readChildren: () => { throw new Error('stale read must not load occurrences'); },
    readParent: () => { throw new Error('stale read must not load parents'); } });
  expect(stale).toEqual({ profile: 'recipe-work-page-stale', structure, revision: otherRevision,
    cursorRevision: revision });
  await expect(readRecipeHierarchyPage({ structure: otherStructure, revision, cursor,
    readChildren: source.readChildren, readParent: source.readParent })).rejects.toBeInstanceOf(WorkReadInvalid);
  source.reset();
  const second = await readRecipeHierarchyPage({ structure, revision, cursor,
    measures: [servingsMeasure(1)], readChildren: source.readChildren, readParent: source.readParent });
  expect(second.profile).toBe('recipe-work-page-v1');
  if (second.profile !== 'recipe-work-page-v1') return;
  expect(second.measures).toEqual([servingsMeasure(1)]);
  expect(second.occurrences[0]?.occurrence).toBe(children[99]?.occurrence);
  expect(second.occurrences[0]?.parent).toBe(section.occurrence);
  expect(second.occurrences.at(-1)?.occurrence).toBe(salt.occurrence);
  expect(second.occurrences.at(-1)?.parent).toBe(structure);
  expect(second.next).toBeUndefined();
  expect(second.ingredients[0]?.amount).toEqual({ numerator: 2, denominator: 1 });
  expect(second.ingredients.at(-1)?.amount).toEqual({ numerator: 2, denominator: 1 });
  const replay = await readRecipeHierarchyPage({ structure, revision, cursor,
    readChildren: source.readChildren, readParent: source.readParent });
  expect(replay.profile === 'recipe-work-page-v1' && replay.occurrences.map(item => item.occurrence))
    .toEqual(second.occurrences.map(item => item.occurrence));
  const walked = await walk(records, { servings: 8, measures });
  expect(walked.seen).toEqual(depthFirst(records, structure).map(item => item.occurrence));
  expect(walked.pages).toBe(2);
});

test('a cursor resumes at the next section when a page ends on a section boundary', async () => {
  const cake = node(structure, 0, 'group', undefined, 'Cake');
  const cakeChildren = Array.from({ length: 99 }, (_, order) => ingredient(cake.occurrence, order, `1 cup flour ${order}`));
  const frosting = node(structure, 1, 'group', undefined, 'Frosting');
  const sugar = ingredient(frosting.occurrence, 0, '1 cup sugar');
  const records = [cake, ...cakeChildren, frosting, sugar];
  const source = fixture(records);
  const first = await readRecipeHierarchyPage({ structure, revision, measures: [servingsMeasure(4)],
    readChildren: source.readChildren, readParent: source.readParent });
  expect(first.profile).toBe('recipe-work-page-v1');
  if (first.profile !== 'recipe-work-page-v1') return;
  expect(first.occurrences).toHaveLength(RECIPE_WORK_PAGE_OCCURRENCES);
  expect(first.occurrences[0]?.occurrence).toBe(cake.occurrence);
  expect(first.occurrences.at(-1)?.occurrence).toBe(cakeChildren.at(-1)?.occurrence);
  expect(first.occurrences.at(-1)?.parent).toBe(cake.occurrence);
  expect(first.occurrences.some(item => item.occurrence === frosting.occurrence)).toBe(false);
  expect(first.next).toBeString();
  const second = await readRecipeHierarchyPage({ structure, revision, cursor: first.next,
    measures: [servingsMeasure(4)], readChildren: source.readChildren, readParent: source.readParent });
  expect(second.profile).toBe('recipe-work-page-v1');
  if (second.profile !== 'recipe-work-page-v1') return;
  expect(second.occurrences.map(item => item.occurrence)).toEqual([frosting.occurrence, sugar.occurrence]);
  expect(second.occurrences.map(item => item.parent)).toEqual([structure, frosting.occurrence]);
  expect(second.next).toBeUndefined();
  const replay = await readRecipeHierarchyPage({ structure, revision, cursor: first.next,
    readChildren: source.readChildren, readParent: source.readParent });
  expect(replay.profile === 'recipe-work-page-v1' && replay.occurrences.map(item => item.occurrence))
    .toEqual([frosting.occurrence, sugar.occurrence]);
  const walked = await walk(records);
  expect(walked.seen).toEqual(depthFirst(records, structure).map(item => item.occurrence));
  expect(walked.pages).toBe(2);
});

test('many short sections stay inside the read bound and finish in order', async () => {
  const records: OccurrenceRecord[] = [];
  for (let index = 0; index < 20; index += 1) {
    const group = node(structure, index, 'group', undefined, `section ${index}`);
    records.push(group, ingredient(group.occurrence, 0, `1 cup flour ${index}`));
  }
  const walked = await walk(records);
  expect(walked.seen).toEqual(depthFirst(records, structure).map(item => item.occurrence));
  expect(walked.pages).toBeGreaterThan(1);
  expect(walked.sizes[0]).toBeGreaterThan(2);
  expect(walked.sizes[0]).toBeLessThan(RECIPE_WORK_PAGE_OCCURRENCES);
  expect(walked.sizes.reduce((sum, size) => sum + size, 0)).toBe(records.length);
});
