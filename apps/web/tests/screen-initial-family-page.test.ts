import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('Screen creation complete, recovery and long review states use AppShell plus ScreenProfile', () => {
  const story = readFileSync(
    new URL('../src/stories/catalogue-screen-initial-family.stories.tsx', import.meta.url),
    'utf8',
  );
  expect(story).toContain("import { AppShell } from '../shell/shell'");
  expect(story).toContain('<ScreenProfile');
  expect(story).toContain("long={mode === 'long'}");
  expect(story).toMatch(/supplementary \? body : <AppShell>\{body\}<\/AppShell>/);
  expect(story).toContain("querySelectorAll('main#main-content')");
  expect(story).toContain("querySelector('main#main-content')).toBeNull()");
  const exports = [...story.matchAll(/export const (\w+): Story =/g)].map((entry) => entry[1]);
  for (const name of [
    'CompleteCreation',
    'ExactUncertainReplay',
    'CurrentReaderRetirement',
    'LongLocalizedFactsAndCredits',
    'CreatedReaderRecovery',
    'IndependentSelectors',
  ])
    expect(exports).toContain(name);
  const independent = story.slice(
    story.indexOf('export const IndependentSelectors'),
    story.indexOf('export const LongLocalizedFactsAndCredits'),
  );
  expect(independent).toContain("mode: 'independent'");
  expect(independent).not.toContain('<AppShell>');
});
