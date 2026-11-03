import { expect, test } from 'bun:test';
import { checkGrowth, measure } from '../support/growth.ts';
import { seedCollectionGrowthPopulation } from './support/collection-growth-population.ts';
import { createSavedQueryEvaluationGrowthFixture } from './support/saved-query-evaluation-growth-fixture.ts';

const scales = [64, 512, 4096] as const;
type Page = { members: { kind: 'dynamic'; subjectId: string }[]; next: string | null };
type PlanNode = {
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

function assertIndexedNegativeWitness(plan: PlanNode) {
  const nodes = planNodes(plan);
  const witness = nodes.find(
    (node) => node['Index Name'] === 'owner_index_label_legacy' || node['Index Name'] === 'owner_index_label_live',
  );
  expect(witness, JSON.stringify(plan)).toBeDefined();
  expect(witness!['Actual Loops']).toBeGreaterThan(0);
  expect(witness!['Actual Rows']).toBeLessThanOrEqual(1);
  expect(witness!['Rows Removed by Filter'] ?? 0).toBe(0);
  expect((witness!['Shared Hit Blocks'] ?? 0) + (witness!['Shared Read Blocks'] ?? 0)).toBeGreaterThan(0);
}

test('saved member pages compose across source depth and retained-label growth', async () => {
  const f = await createSavedQueryEvaluationGrowthFixture();
  try {
    const reduced = await f.credential('ordinary', ['collection:read', 'subject:read']);
    const expected = [...f.subjectIds].sort();
    await f.retainDeletedHistory(f.targetSubjectId, 64);
    await f.retainDeletedHistory(f.targetSubjectId, 64, f.other, f.otherAccountId);
    await f.retainDeletedHistory(f.unrelatedSubjectId, 64);

    async function page(cursor?: string, bearer = f.owner) {
      const response = await f.requestPage(cursor, 2, bearer);
      expect(response.status).toBe(200);
      return (await response.json()) as Page;
    }

    const check = async (name: string, grow: (scale: number, previous: number) => Promise<void>) => {
      const witnessByScale = new Map<number, { deep: string; terminal: string }>();
      const settlements = new Map<number, { preparations: number; rows: number; statements: number; bytes: number }>();
      const cases = new Map<number, number>();

      async function prepareScale(scale: number) {
        if (witnessByScale.has(scale)) return;
        const measured = await measure(f.database, async () => {
          const settled = await f.settlePage(undefined, 2);
          const page = settled.response.status === 200 ? ((await settled.response.json()) as Page) : null;
          return { preparations: settled.preparations, status: settled.response.status, page };
        });
        expect(measured.value.status).toBe(200);
        expect(measured.value.page).not.toBeNull();
        settlements.set(scale, {
          preparations: measured.value.preparations,
          rows: measured.cost.rows + (measured.cost.backgroundRows ?? 0),
          statements: measured.cost.statements + (measured.cost.backgroundStatements ?? 0),
          bytes: (measured.cost.requestBytes ?? 0) + (measured.cost.responseBytes ?? 0),
        });
        const first = measured.value.page!;
        expect(first.members.map((row) => row.subjectId)).toEqual(expected.slice(0, 2));
        expect(first.next).toBeString();
        const deep = await f.settlePage(first.next!, 2);
        expect(deep.response.status).toBe(200);
        const deepPage = (await deep.response.json()) as Page;
        expect(deepPage.members.map((row) => row.subjectId)).toEqual(expected.slice(2, 4));
        expect(deepPage.next).toBeString();
        const terminal = await f.settlePage(deepPage.next!, 2);
        expect(terminal.response.status).toBe(200);
        const terminalPage = (await terminal.response.json()) as Page;
        expect(terminalPage.members.map((row) => row.subjectId)).toEqual(expected.slice(4));
        expect(terminalPage.next).toBeNull();
        witnessByScale.set(scale, { deep: first.next!, terminal: deepPage.next! });
      }

      const report = await checkGrowth(f.database, {
        name,
        scales: [...scales],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        async grow(database, scale, previous) {
          await grow(scale, previous);
          await seedCollectionGrowthPopulation(
            database,
            scale / 1024,
            previous / 1024,
            f.ownerAccountId,
            f.targetSubjectId,
          );
          assertIndexedNegativeWitness(await f.explainUnidentifiedWitness());
        },
        async warmup(_database, scale) {
          await prepareScale(scale);
        },
        async prepare(_database, scale) {
          await prepareScale(scale);
        },
        async operation(_database, scale) {
          const cursors = witnessByScale.get(scale);
          if (!cursors) throw new Error(`No current cursor witnesses at scale ${scale}`);
          const first = await page();
          expect(first.members.map((row) => row.subjectId)).toEqual(expected.slice(0, 2));
          expect(first.next).toBeString();
          const deep = await page(cursors.deep);
          expect(deep.members.map((row) => row.subjectId)).toEqual(expected.slice(2, 4));
          expect(deep.next).toBeString();
          const terminal = await page(cursors.terminal);
          expect(terminal.members.map((row) => row.subjectId)).toEqual(expected.slice(4));
          expect(terminal.next).toBeNull();
          expect((await f.requestPage(undefined, 2, f.other)).status).toBe(404);
          expect((await f.requestPage(undefined, 2, reduced)).status).toBe(403);
          cases.set(scale, (cases.get(scale) ?? 0) + 1);
        },
      });
      return { report, settlements, cases };
    };

    const sourceDepth = await check('saved member wrapper with selected owner-fact depth', async (scale, previous) => {
      for (let count = previous; count < scale; count++) await f.completeSession(f.targetSubjectId);
    });
    const retainedHistory = await check('saved member wrapper with same-original retained label history', async (scale) => {
      await f.retainDeletedHistory(f.targetSubjectId, scale);
    });

    for (const { report, settlements, cases } of [sourceDepth, retainedHistory]) {
      expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
      for (const sample of report.samples)
        for (const cost of sample.repetitions) {
          expect(cost.statements + (cost.backgroundStatements ?? 0)).toBeGreaterThan(0);
          expect(cost.rows + (cost.backgroundRows ?? 0)).toBeGreaterThan(0);
          expect(cost.blocks + (cost.backgroundBlocks ?? 0)).toBeGreaterThan(0);
          expect(cost.requestBytes).toBeDefined();
          expect(cost.responseBytes).toBeDefined();
        }
      for (const scale of scales) {
        expect(cases.get(scale)).toBeGreaterThan(0);
        const settled = settlements.get(scale);
        expect(settled).toBeDefined();
        expect(settled!.rows).toBeGreaterThan(0);
        expect(settled!.statements).toBeGreaterThan(0);
        expect(settled!.bytes).toBeGreaterThan(0);
      }
    }

    const restore = await f.unidentifiedWitness();
    try {
      expect((await f.requestPage()).status).toBe(503);
    } finally {
      await restore();
    }
    const corrected = await f.settlePage();
    expect(corrected.response.status).toBe(200);
    const correctedPage = (await corrected.response.json()) as Page;
    expect(correctedPage.members.map((row) => row.subjectId)).not.toContain(f.targetSubjectId);
  } finally {
    await f.close();
  }
}, 900_000);
