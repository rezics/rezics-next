import { expect, test } from 'bun:test';

const source = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

function scenario(story: string, name: string) {
  const start = story.indexOf(`export const ${name}:`);
  const rest = story.slice(start + 1);
  const next = rest.search(/\nexport const /);
  return story.slice(start, next === -1 ? story.length : start + 1 + next);
}

test('Order component examples use the shared AppShell frame for a representative receipt and reconciliation', async () => {
  const story = await source('../src/stories/order.stories.tsx');
  const shell = await source('../src/shell/shell.tsx');
  const sidebar = await source('../../../packages/ui/src/shadcn/sidebar.tsx');
  const page = await source('../src/checkout/order-page.tsx');

  expect(story).toContain("import { AppShell } from '../shell/shell'");
  expect(story).toMatch(
    /function OrderPattern[\s\S]*?<PatternStory\s+visitor="Signed In"\s+path=\{`\/orders\/\$\{id\}`\}>\s*<AppShell>\{children\}<\/AppShell>\s*<\/PatternStory>/,
  );
  expect(shell).toMatch(/<SidebarInset\s+id="main-content"/);
  expect(sidebar).toMatch(/function SidebarInset\b[\s\S]*?return\s*\(\s*<main\b/);
  expect(story).not.toMatch(/<main\b/);
  expect(page).not.toMatch(/<main\b/);
  expect(story).toContain("getByRole('main')");
  expect(story).toContain('remain pattern evidence');
  expect(story).toContain('actual-route cases wait on Commerce producer-owned matching responses');

  const exports = [...story.matchAll(/export const (\w+): Story =/g)].map((entry) => entry[1]);
  expect(exports).toEqual([
    'Paid',
    'Pending',
    'Failed',
    'FailedAfterReturn',
    'Canceled',
    'Active',
    'Refunded',
    'AccessUnavailable',
    'NoEntitlement',
    'AccessRefresh',
    'RecordedCharge',
    'LongReceiptNarrow',
    'UnknownSettlement',
    'RecordedMoneyUnavailable',
    'MappedCurrentUse',
    'ReconciliationQueued',
    'ReconciliationUnavailable',
    'ReconciliationDenied',
    'ReconciliationRetry',
    'MappedFixedEdition',
  ]);
  for (const name of [
    'Paid',
    'Pending',
    'Failed',
    'Canceled',
    'RecordedCharge',
    'MappedCurrentUse',
    'MappedFixedEdition',
  ]) {
    expect(scenario(story, name)).toContain('<PageStory visitor="Signed In"');
    expect(scenario(story, name)).not.toContain('(component)');
  }
  for (const name of ['Refunded', 'LongReceiptNarrow', 'UnknownSettlement', 'ReconciliationRetry']) {
    expect(scenario(story, name)).toContain('(component)');
  }
  expect(story).toContain('<OrderPattern id={order.id}>');
  expect(scenario(story, 'Refunded')).toContain("entitlement={{ kind: 'current', active: false }}");
  expect(scenario(story, 'Refunded')).toContain('m.order_entitlement_revoked()');
  expect(story.slice(story.indexOf('function currentReceiptReady'), story.indexOf('export const Active:'))).toContain(
    'paidRecording.order.id',
  );
  expect(story).toContain('receiptStoryMoney.taxCode');
  const unknown = scenario(story, 'UnknownSettlement');
  expect(unknown).toContain("settlement: 'unknown'");
  expect(unknown).toContain('pendingRecording.order.id');
  expect(unknown).toContain('queryByText(m.order_paid_total())).toBeNull()');
  expect(unknown).toContain("queryByRole('link', { name: m.benefit_open_reader() })).toBeNull()");
  const retry = scenario(story, 'ReconciliationRetry');
  expect(retry).toContain('send={async ({ orderId }) =>');
  expect(retry).toContain("throw new Error('Response lost')");
  expect(retry).toContain("return { kind: 'queued', orderId, reconciliation: 'queued' }");
  expect(retry).toContain('m.order_reconcile_retry()');
});
