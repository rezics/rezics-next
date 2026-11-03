import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import type { WorkbenchCase } from '../src/moderation/workbench-queue/read';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/moderation/workbench' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { m } = await import('../src/paraglide/messages.js');
const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
const { WorkbenchView } = await import('../src/moderation/workbench-queue/view');
const {
  WorkbenchTriageCase,
  workbenchTriageDetailFields,
  workbenchTriageOutcome,
  workbenchTriageTime,
} = await import('../src/moderation/workbench-triage');

const reportId = '0192f3a0-6c1e-7b2a-9d4e-000000000401';
const appealId = '0192f3a0-6c1e-7b2a-9d4e-000000000501';
const evidence = 'Private evidence for the moderator list.';
const statement = 'Please restore the post.';
const pending: WorkbenchCase = {
  kind: 'report',
  id: reportId,
  createdAt: '2026-10-28T10:00:00.000Z',
  outcome: null,
  reason: 'spam',
  evidence,
  statement: null,
  decisionId: null,
  target: { kind: 'post', id: 'post-1' },
};
const resolved: WorkbenchCase = {
  ...pending,
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000402',
  outcome: 'actioned',
  evidence: null,
};
const appeal: WorkbenchCase = {
  kind: 'appeal',
  id: appealId,
  createdAt: '2026-10-29T10:00:00.000Z',
  outcome: null,
  reason: null,
  evidence: null,
  statement,
  decisionId: 'decision-1',
  target: { kind: 'post', id: 'post-1' },
};
const search = workbenchSearch({ board: 'board-club', queue: 'reports' });
const ready = {
  state: 'ready' as const,
  realms: [] as [],
  realmsNext: null,
  boards: [] as [],
  boardsNext: null,
  next: null,
};

async function mount(node: React.ReactNode) {
  const host = document.createElement('main');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return { host, root };
}

function button(host: Element, label: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent === label);
}

test('pending, resolved and appeal summaries keep native type, reason, outcome and references', async () => {
  const { host } = await mount(
    <WorkbenchView
      page={{
        ...ready,
        search,
        generation: 'gen-1',
        cases: [pending, resolved, appeal],
      }}
      onSearch={() => {}}
    />,
  );
  expect(host.textContent).toContain(m.moderation_workbench_triage_report());
  expect(host.textContent).toContain(m.report_spam());
  expect(host.textContent).toContain(m.reporter_status_pending());
  expect(host.textContent).toContain(m.moderation_actioned());
  expect(host.textContent).toContain(m.moderation_workbench_triage_appeal());
  expect(host.textContent).toContain(statement);
  expect(host.textContent).toContain(evidence);
  expect(host.textContent).not.toContain(m.report_illegal());
  const hrefs = [...host.querySelectorAll('a')].map((link) => link.getAttribute('href') ?? '');
  expect(hrefs.some((href) => href.includes('/boards/board-club/moderation'))).toBe(true);
  expect(hrefs.join(' ')).not.toContain(evidence);
  expect(hrefs.join(' ')).not.toContain(statement);
  expect(hrefs.join(' ')).not.toContain('decision-1');
  const appealFields = workbenchTriageDetailFields(appeal, 'en');
  expect(appealFields.some((field) => field.key === 'decision-id' && field.value === 'decision-1')).toBe(true);
  expect(appealFields.some((field) => field.key === 'reason')).toBe(false);
  expect(workbenchTriageOutcome(null).presence).toBe('absent');
  expect(workbenchTriageOutcome('actioned').value).toBe(m.moderation_actioned());
});

test('inspecting details returns focus, and a new read identity retires the panel', async () => {
  function App({ identity, item = pending }: { identity: string; item?: WorkbenchCase }) {
    return <WorkbenchTriageCase item={item} identity={identity} locale="en" />;
  }
  const { host, root } = await mount(<App identity="queue:gen-1" />);
  const inspect = button(host, m.moderation_workbench_triage_inspect());
  expect(inspect).toBeDefined();
  inspect?.focus();
  await act(async () => {
    inspect?.click();
  });
  expect(host.textContent).toContain(m.moderation_workbench_triage_details());
  expect(host.textContent).toContain(m.moderation_queue_details_report_id());
  expect(host.querySelector('a')).toBeNull();
  const close = button(host, m.moderation_workbench_triage_close());
  await act(async () => {
    close?.click();
  });
  expect(host.textContent).not.toContain(m.moderation_workbench_triage_details());
  expect(document.activeElement).toBe(inspect);
  await act(async () => {
    inspect?.click();
  });
  expect(host.textContent).toContain(m.moderation_workbench_triage_details());
  await act(async () => {
    root.render(<App identity="queue:gen-2" />);
  });
  expect(host.textContent).not.toContain(m.moderation_workbench_triage_details());
  expect(button(host, m.moderation_workbench_triage_inspect())).toBeDefined();
});

test('empty and denied pages drop prior cases; invalid time and absent evidence stay honest', async () => {
  const { host, root } = await mount(
    <WorkbenchView
      page={{ ...ready, search, generation: 'gen-1', cases: [pending] }}
      onSearch={() => {}}
    />,
  );
  expect(host.textContent).toContain(evidence);
  await act(async () => {
    root.render(
      <WorkbenchView page={{ ...ready, state: 'denied', search, generation: 'gen-2', cases: [] }} onSearch={() => {}} />,
    );
  });
  expect(host.textContent).toContain(m.moderation_workbench_denied());
  expect(host.textContent).not.toContain(evidence);
  expect(workbenchTriageTime('not-a-time', 'en')).toBeNull();
  expect(workbenchTriageDetailFields({ ...pending, createdAt: 'not-a-time', evidence: null }, 'en').map((field) => [
    field.key,
    field.presence,
  ])).toContainEqual(['created', 'unavailable']);
  expect(
    workbenchTriageDetailFields({ ...pending, evidence: null }, 'en').some(
      (field) => field.key === 'evidence' && field.presence === 'absent',
    ),
  ).toBe(true);
});
