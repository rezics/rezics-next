import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  discoverJourneyPreparations,
  preparationBudgetMs,
  selectJourneyPreparations,
  type JourneyPreparation,
} from '../../../scripts/qa/e2e-preparation.ts';

const repo = resolve(import.meta.dir, '../../..');
const scoped = 'apps/web/tests/scoped-subjects-journey.e2e.ts';

function declared(journey: string, budgetMs: number): JourneyPreparation {
  return {
    journey,
    command: ['bun', 'apps/web/tests/scoped-subjects-journey-seed.ts'],
    budgetMs,
    step: `${journey} preparation`,
    slug: 'journey-seed',
  };
}

const scopedPreparation = declared(scoped, 600_000);
const otherPreparation = declared('apps/web/tests/public-search.e2e.ts', 120_000);
const preparations = [otherPreparation, scopedPreparation];

test('a selected journey runs its preparation once and adds only its budget', () => {
  const selected = selectJourneyPreparations(preparations, [scoped, '--grep', 'rating', scoped]);
  expect(selected.map((item) => item.journey)).toEqual([scoped]);
  expect(preparationBudgetMs(selected)).toBe(600_000);
  const absolute = selectJourneyPreparations(preparations, [`/opt/rezics/${scoped}`]);
  expect(absolute.map((item) => item.journey)).toEqual([scoped]);
});

test('the whole e2e tier runs every journey preparation', () => {
  for (const args of [[], ['--grep', 'mobile search']] as const) {
    const selected = selectJourneyPreparations(preparations, args);
    expect(selected.map((item) => item.journey)).toEqual([
      'apps/web/tests/public-search.e2e.ts',
      scoped,
    ]);
    expect(preparationBudgetMs(selected)).toBe(720_000);
  }
});

test('other journeys add no preparation', () => {
  const selected = selectJourneyPreparations(preparations, ['apps/web/tests/work-page.e2e.ts']);
  expect(selected).toEqual([]);
  expect(preparationBudgetMs(selected)).toBe(0);
  const onlyOther = selectJourneyPreparations(preparations, [
    'apps/web/tests/public-search.e2e.ts',
  ]);
  expect(onlyOther.map((item) => item.journey)).toEqual(['apps/web/tests/public-search.e2e.ts']);
  expect(preparationBudgetMs(onlyOther)).toBe(120_000);
});

test('the scoped-subjects journey keeps its seed command and 600s budget', async () => {
  const declaredPreparations = await discoverJourneyPreparations(repo);
  expect(declaredPreparations.find((item) => item.journey === scoped)).toEqual({
    journey: scoped,
    command: ['bun', 'apps/web/tests/scoped-subjects-journey-seed.ts'],
    budgetMs: 600_000,
    step: 'Scoped subjects preparation',
    slug: 'scoped-subjects-seed',
  });
  expect(
    selectJourneyPreparations(declaredPreparations, [scoped]).map((item) => item.journey),
  ).toEqual([scoped]);
  expect(preparationBudgetMs(selectJourneyPreparations(declaredPreparations, [scoped]))).toBe(
    600_000,
  );
  expect(
    selectJourneyPreparations(declaredPreparations, []).some((item) => item.journey === scoped),
  ).toBe(true);
  const others = selectJourneyPreparations(declaredPreparations, [
    'apps/web/tests/public-search.e2e.ts',
  ]);
  expect(others.some((item) => item.journey === scoped)).toBe(false);
  expect(preparationBudgetMs(others)).toBe(0);
});

async function withTree(
  files: Record<string, string>,
  check: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'e2e-preparation-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    await check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const seed = 'apps/web/tests/example-seed.ts';
const journey = 'apps/web/tests/example.e2e.ts';

test('a sibling prepare module declares the same preparation', async () => {
  await withTree(
    {
      [seed]: 'export {}\n',
      [journey]: 'export {}\n',
      'apps/web/tests/example.prepare.ts': `export const preparation = {
      command: ['bun', '${seed}'],
      budgetMs: 600_000,
      step: 'Example preparation',
      slug: 'example-seed',
    };\n`,
    },
    async (root) => {
      const found = await discoverJourneyPreparations(root);
      expect(found.map((item) => item.journey)).toEqual([journey]);
      expect(found[0]?.budgetMs).toBe(600_000);
    },
  );
});

test('a preparation budget above the data-preparation ceiling is refused', async () => {
  await withTree(
    {
      [seed]: 'export {}\n',
      [journey]: "import { test } from '@playwright/test';\n",
      'apps/web/tests/example.prepare.ts': `export const preparation = {
      command: ['bun', '${seed}'],
      budgetMs: 600_001,
      step: 'Example preparation',
      slug: 'example-seed',
    };\n`,
    },
    async (root) => {
      await expect(discoverJourneyPreparations(root)).rejects.toThrow('600000');
    },
  );
});
