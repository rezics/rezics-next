import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const composedStates = {
  History: 'history',
  SecondPage: 'second-page',
  Empty: 'empty',
  LaterEmpty: 'later-empty',
  Denied: 'denied',
  Unavailable: 'unavailable',
  Error: 'error',
  Stale: 'stale',
  Loading: 'loading',
  Preparing: 'preparing',
  Incomplete: 'incomplete',
  UnknownUnit: 'unknown-unit',
  LongTitle: 'long-title',
  OtherCreatorSameRoute: 'other-creator',
  OtherCreatorDenied: 'denied',
} as const;

test('Creator Sales Pages stories compose named constructed states in AppShell and keep actual unavailable on the served path', () => {
  const story = source('../src/stories/creator-sales.stories.tsx');
  const page = source('../src/checkout/creator-sales-page.tsx');
  const shell = source('../src/shell/shell.tsx');
  const sidebar = source('../../../packages/ui/src/shadcn/sidebar.tsx');

  expect(story).toContain("title: 'Pages/Commerce/Creator Sales'");
  expect(story).toContain("import { AppShell } from '../shell/shell'");
  expect(story).toContain("import { PageStory, PatternStory, pageReady } from './page'");
  expect(story).toMatch(/<PatternStory visitor="Signed In" path="\/creator\/sales">\s*<AppShell>\s*<CreatorSalesPage/);
  expect(shell).toMatch(/<SidebarInset\s+id="main-content"/);
  expect(sidebar).toMatch(/function SidebarInset\b[\s\S]*?return\s*\(\s*<main\b/);
  expect(story).not.toMatch(/<main\b/);
  expect(page).not.toMatch(/<main\b/);

  const exports = [...story.matchAll(/export const (\w+): Story =/g)];
  expect(exports.map((entry) => entry[1])).toEqual([...Object.keys(composedStates), 'ActualRoute']);
  const scenarios = Object.fromEntries(
    exports.map((entry, index) => [entry[1]!, story.slice(entry.index, exports[index + 1]?.index ?? story.length)]),
  );
  for (const [name, state] of Object.entries(composedStates)) {
    expect(scenarios[name]).toContain(`render('${state}')`);
  }
  for (const name of [
    'History',
    'SecondPage',
    'Empty',
    'LaterEmpty',
    'Denied',
    'Preparing',
    'Incomplete',
    'UnknownUnit',
    'LongTitle',
  ]) {
    expect(scenarios[name]).toContain("findByRole('main')");
  }
  expect(scenarios.History).toContain("getByRole('heading', { level: 1, name: m.creator_sales_heading() })");
  expect(scenarios.History).toContain('canvasElement.querySelector(\'a[href*="/orders/"]\')');
  expect(scenarios.SecondPage).toContain('m.creator_sales_restart()');
  expect(scenarios.Empty).toContain('m.creator_sales_empty()');
  expect(scenarios.Empty).toContain('m.creator_sales_preparing()');
  expect(scenarios.LaterEmpty).toContain('m.creator_sales_page_empty()');
  expect(scenarios.LaterEmpty).toContain('m.creator_sales_restart()');
  expect(scenarios.LaterEmpty).toContain('m.creator_sales_preparing()');
  expect(scenarios.Preparing).toContain('m.creator_sales_preparing()');
  expect(scenarios.Preparing).toContain('m.creator_sales_empty()');
  expect(scenarios.Incomplete).toContain("getByRole('heading', { level: 2, name: creatorSaleFixture.title })");
  expect(scenarios.UnknownUnit).toContain('m.statements_amount_unavailable()');
  expect(scenarios.LongTitle).toContain("getByRole('heading', { level: 2, name: page.sales[0]!.title })");
  expect(scenarios.Denied).toContain('m.creator_sales_denied()');
  expect(scenarios.OtherCreatorDenied).toContain("render('denied')");
  expect(scenarios.ActualRoute).toContain('<PageStory visitor="Signed In" path="/creator/sales" />');
  expect(scenarios.ActualRoute).toContain('findByText(m.creator_sales_unavailable())');

  expect(story).toContain('constructed presentation examples');
  expect(story).toContain('positive available-route provenance remains unmeasured');
  expect(story).not.toMatch(/ok:\s*true|viewport|maxWidth/);
});
