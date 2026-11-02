import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { dirname } from 'node:path';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/inbox' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { ReporterStatusPage } = await import('../src/moderation/reporter-status-view');
const { m } = await import('../src/paraglide/messages.js');
const report = {
  id: 'report-1',
  target: { kind: 'post' as const, id: 'post-1' },
  revisionId: 'revision-1' as string | null,
  reason: 'spam' as const,
  evidence: 'Submitted evidence',
  reporterId: 'reporter-1',
  createdAt: '2026-10-30T10:00:00.000Z',
  resolvedAt: null,
  outcome: null,
  targetAvailability: 'unavailable' as const,
};
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
const root = createRoot(host);
let admitted = true;
const isCurrent = () => admitted;
const writes: string[] = [];
Object.defineProperty(window.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text: string) => { writes.push(text); throw new Error('Clipboard denied'); } },
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('clipboard denial selects the exact current reference and retirement hides and disables recovery', async () => {
  for (const revisionId of ['revision-1', null] as const) {
    const currentReport = { ...report, id: `report-${revisionId ?? 'without-revision'}`, revisionId };
    await act(async () => root.render(createElement(ReporterStatusPage, { report: currentReport, isCurrent })));
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    details.open = true;
    const copy = host.querySelector('button')!;
    await act(async () => { copy.click(); await tick(); });
    const expected = [
      `${m.reporter_status_report_id()}: ${currentReport.id}`,
      `${m.reporter_status_target()}: post post-1`,
      ...(revisionId ? [`${m.reporter_status_revision()}: ${revisionId}`] : []),
    ].join('\n');
    const fallback = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(fallback.readOnly).toBe(true);
    expect(fallback.labels?.[0]?.textContent?.trim()).toBe(m.reporter_status_reference());
    expect(fallback.value).toBe(expected);
    expect(writes.at(-1)).toBe(expected);
    expect(document.activeElement).toBe(fallback);
    expect(fallback.selectionStart).toBe(0);
    expect(fallback.selectionEnd).toBe(expected.length);
    const close = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === m.board_feed_copy_close())!;
    await act(() => close.click());
    expect(fallback.isConnected).toBe(false);
    expect(document.activeElement).toBe(copy);
  }
  const retiredReport = { ...report, id: 'report-retired', revisionId: null };
  await act(async () => root.render(createElement(ReporterStatusPage, { report: retiredReport, isCurrent })));
  host.querySelector('details')!.open = true;
  await act(async () => { host.querySelector('button')!.click(); await tick(); });
  expect(host.querySelector('textarea')).not.toBeNull();
  admitted = false;
  await act(() => root.render(createElement(ReporterStatusPage, { report: retiredReport, isCurrent })));
  expect(host.querySelector('textarea')).toBeNull();
  const writeCount = writes.length;
  await act(() => host.querySelector('button')!.click());
  expect(writes).toHaveLength(writeCount);
  await act(() => root.unmount());
});
