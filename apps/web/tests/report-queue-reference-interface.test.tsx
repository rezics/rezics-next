import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { Report, ReportReadState } from '../src/moderation/reports-read';
import type { ReportQueueAction } from '../src/moderation/reports-view-action';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

// Authored UNRUN: mounted production presenters over supplied records/pages and callback settlements.
// No private SSR channel, session/cache injection or substitute native authority is used here.
// Browser keyboard activation, physical 390/1280/RTL layout and native authority remain owed.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
afterAll(() => mock.restore());

const report: Report = {
  id: `report-${'exact-supplied-reference-'.repeat(4)}`,
  target: { kind: 'post', id: 'current-target-kept-in-its-existing-branch' },
  revisionId: 'unavailable-revision-never-admitted-by-the-report',
  reason: `Complete submitted reason.\n\n${'Human context remains primary. '.repeat(12)}End of reason.`,
  evidence: `Complete submitted evidence.\n\n${'Full evidence paragraph. '.repeat(60)}\n${'unbroken'.repeat(60)}\nEnd of evidence.`,
  createdAt: '2026-10-28T15:30:12.123456Z',
  outcome: null,
  resolvedAt: null,
};
const target = {
  key: `post:${report.target.id}`,
  kind: 'post' as const,
  value: { post: { body: 'Separately supplied current post text.' } },
};
const revision = { post: { body: 'Separately supplied reported post text.' } };
const cursor = 'opaque+/supplied-continuation==';
const decisionReason = `Complete moderator decision.\n\n${'The full review context is retained. '.repeat(20)}End of decision.`;
type ActionResult = Awaited<ReturnType<ReportQueueAction>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function withDom(
  run: (context: {
    host: HTMLElement;
    window: InstanceType<typeof Window>;
    render: (node: ReactNode) => Promise<void>;
    flush: () => Promise<void>;
  }) => Promise<void>,
) {
  const window = new Window({ url: 'https://site.test/en/boards/community/moderation' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    NodeFilter: window.NodeFilter,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const locale = getLocale();
  const flush = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  try {
    setLocale('en', { reload: false });
    await run({
      host,
      window,
      flush,
      render: async (node) => {
        await act(async () => root.render(node));
        await flush();
      },
    });
  } finally {
    await act(async () => root.unmount());
    setLocale(locale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
async function click(host: HTMLElement, label: string, flush: () => Promise<void>) {
  await act(async () => button(host, label).click());
  await flush();
}
function reference(host: HTMLElement, row = report) {
  const details = host.querySelector('details')!;
  expect(details).not.toBeNull();
  const summary = details.querySelector('summary')!;
  expect(summary.textContent).toBe(m.moderation_queue_details_reference());
  expect(details.getAttribute('aria-labelledby')).toBe(summary.id);
  expect(details.querySelector('dt')?.textContent).toBe(m.moderation_queue_details_report_id());
  const values = [...details.querySelectorAll('dd')];
  expect(values.map((value) => value.textContent)).toEqual([row.id]);
  expect(values[0]!.getAttribute('dir')).toBe('ltr');
  for (const token of ['select-text', 'break-all', '[overflow-wrap:anywhere]'])
    expect(values[0]!.className).toContain(token);
  expect(details.textContent).not.toContain(row.target.id);
  if (row.revisionId) expect(details.textContent).not.toContain(row.revisionId);
  expect(details.querySelector('button, a, form, time')).toBeNull();
  expect(summary.className).toContain('min-h-11');
  expect(summary.className).toContain('focus-visible:outline-ring');
  expect(summary.tabIndex).toBe(0);
  summary.focus();
  expect(summary.ownerDocument.activeElement).toBe(summary);
  return { details, summary };
}

test('Finish moderator report reference and precise receipt dates', async () => {
  await withDom(async ({ host, render }) => {
    const { ReportReviewCard } = await import('../src/moderation/reports-view-card');
    let commands = 0;
    let reads = 0;
    for (const width of [390, 1280]) {
      for (const dir of ['ltr', 'rtl']) {
        for (const outcome of [null, 'actioned', 'dismissed'] as const) {
          const row = {
            ...report,
            outcome,
            resolvedAt: outcome ? '2026-10-29T08:45:23.120400Z' : null,
          };
          await render(
            <div key={`${width}-${dir}-${outcome}`} dir={dir} style={{ width }}>
              <ReportReviewCard
                report={row}
                target={target}
                revision={revision}
                takenDown={false}
                onAction={async () => {
                  commands++;
                  return { ok: true };
                }}
                onTakenDown={() => {
                  throw new Error('Disclosure must not take down content');
                }}
                onRefresh={async () => {
                  reads++;
                }}
              />
            </div>,
          );
          const article = host.querySelector('article')!;
          expect(article.querySelector('[role="status"]')).not.toBe(window.document.activeElement);
          expect(host.firstElementChild?.getAttribute('dir')).toBe(dir);
          expect(host.firstElementChild?.getAttribute('style')).toContain(`${width}px`);
          expect(article.textContent).toContain(report.reason);
          expect(article.textContent).toContain(report.evidence!);
          for (const value of article.querySelectorAll('section dl dd')) {
            expect(value.className).toContain('whitespace-pre-wrap');
            expect(value.className).toContain('[overflow-wrap:anywhere]');
          }
          expect(article.textContent).toContain(target.value.post.body);
          expect(article.textContent).toContain(revision.post.body);
          expect(article.querySelector('code')?.textContent).toBe(report.target.id);
          expect(article.querySelector('h2')?.textContent).toContain(m.moderation_queue_post());
          const headings = [...article.querySelectorAll('h2, h3')].map((node) => node.textContent).join(' ');
          expect(headings).not.toContain(report.id);
          for (const heading of [
            m.moderation_queue_submission(),
            m.moderation_reported_revision_label(),
            m.moderation_current_target_label(),
          ])
            expect(headings).toContain(heading);
          expect(article.textContent).toContain(
            outcome === 'actioned'
              ? m.moderation_actioned()
              : outcome === 'dismissed'
                ? m.moderation_dismissed()
                : m.moderation_queue_open(),
          );
          const times = [...article.querySelectorAll('time')];
          expect(times.map((node) => node.getAttribute('datetime'))).toEqual(
            outcome ? [row.createdAt, row.resolvedAt] : [row.createdAt],
          );
          expect(times.map((node) => node.textContent)).toEqual(
            outcome
              ? ['2026-10-28 15:30:12.123456 UTC', '2026-10-29 08:45:23.120400 UTC']
              : ['2026-10-28 15:30:12.123456 UTC'],
          );
          for (const time of times) {
            expect(time.getAttribute('dir')).toBe('ltr');
            expect(time.className).toContain('[overflow-wrap:anywhere]');
          }
          const { details, summary } = reference(host, row);
          expect(details.open).toBe(false);
          expect(details.closest('form, section, header')).toBeNull();
          await act(async () => summary.click());
          expect(details.open).toBe(true);
          expect(article.innerHTML).not.toContain(report.revisionId!);
          expect(commands).toBe(0);
          expect(reads).toBe(0);
        }
      }
    }
    // Seconds-only input must not acquire invented fractional precision.
    await render(
      <ReportReviewCard
        report={{ ...report, createdAt: '2026-10-28T15:30:12Z' }}
        target={target}
        revision={null}
        takenDown={false}
        onAction={async () => {
          commands++;
        }}
        onTakenDown={() => {}}
      />,
    );
    expect(host.querySelector('time')?.textContent).toBe('2026-10-28 15:30:12 UTC');
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-28T15:30:12Z');
    expect(commands).toBe(0);
  });
});

test('report reference stays independent through pending, exact uncertain retry and confirmed projection guidance', async () => {
  await withDom(async ({ host, window, render, flush }) => {
    const { ReportReviewCard } = await import('../src/moderation/reports-view-card');
    const calls: Parameters<ReportQueueAction>[0][] = [];
    const first = deferred<ActionResult>();
    const second = deferred<ActionResult>();
    let reads = 0;
    let takenDown = 0;
    await render(
      <ReportReviewCard
        report={report}
        target={target}
        revision={revision}
        takenDown={false}
        onAction={(input) => {
          calls.push(input);
          return calls.length === 1 ? first.promise : second.promise;
        }}
        onRefresh={async () => {
          reads++;
        }}
        onTakenDown={() => {
          takenDown++;
        }}
      />,
    );
    await click(host, m.moderation_queue_review(), flush);
    const field = host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, decisionReason);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(field.value).toBe(decisionReason);
    await click(host, m.moderation_take_down(), flush);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      action: 'take-down',
      reportId: report.id,
      targetKind: 'post',
      targetId: report.target.id,
      reason: decisionReason,
    });
    expect(host.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
    expect(field.disabled).toBe(true);
    expect(button(host, m.moderation_dismiss()).disabled).toBe(true);
    const { summary } = reference(host);
    await act(async () => summary.click());
    expect(calls).toHaveLength(1);
    expect(reads).toBe(0);
    await act(async () => {
      first.reject(new TypeError('Failed to fetch'));
    });
    await flush();
    expect(host.textContent).toContain(m.moderation_queue_uncertain());
    expect(host.textContent).toContain(m.moderation_queue_retry_hint());
    expect(field.value).toBe(decisionReason);
    expect(field.disabled).toBe(true);
    reference(host);
    await flush();
    expect(calls).toHaveLength(1);
    expect(reads).toBe(0);
    button(host, m.moderation_queue_retry_action()).focus();
    await click(host, m.moderation_queue_retry_action(), flush);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
    await act(async () => {
      second.resolve({ ok: true });
    });
    await flush();
    expect(takenDown).toBe(1);
    expect(reads).toBe(1);
    expect(host.textContent).toContain(m.moderation_queue_takedown_confirmed());
    expect(host.textContent).toContain(m.moderation_queue_projection_pending());
    expect(host.textContent).toContain(decisionReason);
    expect(host.textContent).toContain(report.reason);
    expect(host.textContent).toContain(report.evidence!);
    expect(host.querySelectorAll('time')).toHaveLength(1);
    expect(host.querySelector('textarea')).toBeNull();
    expect(window.document.activeElement).toBe(host.querySelector('[role="status"]'));
    reference(host);
    expect(calls).toHaveLength(2);
  });
});

test('individual settlement follows only the current keyboard submit or retry intent', async () => {
  await withDom(async ({ host, window, render, flush }) => {
    const { ReportReviewCard } = await import('../src/moderation/reports-view-card');
    const { createReportsBulkAction } = await import('../src/moderation/reports-bulk-action');
    for (const mode of [
      'current',
      'submit',
      'focus',
      'focus-return',
      'pointer',
      'pointer-submit',
      'activation',
      'report-return',
      'owner-return',
      'read-return',
      'connection-return',
      'retired',
      'unmount',
    ]) {
      const pending = deferred<ActionResult>();
      const owner = createReportsBulkAction([report]);
      const card = (row = report, intentOwner = owner) => (
        <ReportReviewCard
          key={mode}
          report={row}
          intentOwner={intentOwner}
          target={target}
          revision={revision}
          takenDown={false}
          onAction={() => pending.promise}
          onTakenDown={() => {}}
        />
      );
      await render(card());
      await click(host, m.moderation_queue_review(), flush);
      if (mode === 'submit') {
        const field = host.querySelector('textarea')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Spam');
          field.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
      }
      const source = button(host, mode === 'submit' ? m.moderation_take_down() : m.moderation_dismiss());
      source.focus();
      await act(async () => {
        source.dispatchEvent(
          new window.MouseEvent('click', { bubbles: true, detail: mode === 'pointer-submit' ? 1 : 0 }),
        );
      });
      await flush();
      const summary = host.querySelector('summary')!;
      if (mode === 'focus' || mode === 'focus-return') {
        summary.focus();
        if (mode === 'focus-return') source.focus();
      }
      if (mode === 'pointer') window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      if (mode === 'activation') summary.click();
      if (mode === 'report-return') {
        await render(card({ ...report }));
        await render(card());
      }
      if (mode === 'owner-return') {
        await render(card(report, createReportsBulkAction([report])));
        await render(card());
      }
      if (mode === 'read-return') await act(async () => owner.read(async () => {}));
      if (mode === 'connection-return') {
        owner.detach();
        owner.attach();
      }
      if (mode === 'retired') owner.leave();
      if (mode === 'unmount') {
        await render(<button>Elsewhere</button>);
        host.querySelector('button')!.focus();
      }
      await act(async () => pending.resolve({ ok: true }));
      await flush();
      const result = host.querySelector('[role="status"][tabindex="-1"]');
      expect(result !== null).toBe(!['connection-return', 'retired', 'unmount'].includes(mode));
      if (mode === 'current' || mode === 'submit') {
        expect(window.document.activeElement).toBe(result);
      } else expect(window.document.activeElement).not.toBe(result);
      if (mode === 'focus') expect(window.document.activeElement).toBe(summary);
      if (mode === 'unmount') expect(window.document.activeElement).toBe(host.querySelector('button'));
    }
  });
});

test('definitive refusal keeps explicit refresh and independent dismissal without reference side effects', async () => {
  await withDom(async ({ host, render, flush }) => {
    const { ReportReviewCard } = await import('../src/moderation/reports-view-card');
    const calls: Parameters<ReportQueueAction>[0][] = [];
    let reads = 0;
    let takenDown = 0;
    await render(
      <ReportReviewCard
        report={report}
        target={target}
        revision={null}
        takenDown={false}
        onAction={async (input) => {
          calls.push(input);
          return calls.length === 1 ? { ok: false, state: 'conflict' } : { ok: true };
        }}
        onRefresh={async () => {
          reads++;
        }}
        onTakenDown={() => {
          takenDown++;
        }}
      />,
    );
    await click(host, m.moderation_queue_review(), flush);
    expect(host.querySelector('textarea')?.value).toBe('');
    await click(host, m.moderation_dismiss(), flush);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: 'dismiss', reportId: report.id });
    expect(calls[0]).not.toHaveProperty('targetId');
    expect(host.textContent).toContain(m.moderation_queue_conflict());
    expect(button(host, m.moderation_dismiss()).disabled).toBe(true);
    reference(host);
    expect(reads).toBe(0);
    await click(host, m.moderation_queue_refresh(), flush);
    expect(reads).toBe(1);
    expect(calls).toHaveLength(1);
    await click(host, m.moderation_dismiss(), flush);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey);
    expect(reads).toBe(2);
    expect(takenDown).toBe(0);
    expect(host.textContent).toContain(m.moderation_dismissed());
    expect(host.querySelector('form')).toBeNull();
    reference(host);
  });
});

test('queue denial, unavailable/loading/stale and retirement omit all private report/reference projection', async () => {
  await withDom(async ({ host, render, flush }) => {
    const { BoardReportQueue } = await import('../src/stories/patterns/board-report-queue/board-report-queue');
    const calls: Parameters<ReportQueueAction>[0][] = [];
    const next: string[] = [];
    const pending = deferred<ActionResult>();
    let reads = 0;
    const props = {
      reports: [report],
      targets: [target],
      revisions: [{ reportId: report.id, value: revision }],
      next: cursor,
      bulkEnabled: false,
      onNext: (value: string) => {
        next.push(value);
      },
      onAction: (input: Parameters<ReportQueueAction>[0]) => {
        calls.push(input);
        return pending.promise;
      },
      onRefresh: async () => {
        reads++;
      },
    };
    const hidden = () => {
      for (const value of [report.id, report.evidence!, report.revisionId!, cursor])
        expect(host.innerHTML).not.toContain(value);
      expect(host.querySelector('details, summary, textarea, form, ol')).toBeNull();
      expect(host.querySelector('button')).toBeNull();
    };
    for (const state of ['denied', 'error', 'loading', 'stale'] satisfies ReportReadState[]) {
      await render(<BoardReportQueue key={state} {...props} state={state} />);
      hidden();
    }
    expect(calls).toHaveLength(0);
    await render(<BoardReportQueue key="ready" {...props} />);
    reference(host);
    await click(host, m.moderation_queue_review(), flush);
    await click(host, m.moderation_dismiss(), flush);
    expect(calls).toHaveLength(1);
    await click(host, m.threads_next_page(), flush);
    hidden();
    expect(next).toEqual([cursor]);
    await act(async () => {
      pending.resolve({ ok: true });
    });
    await flush();
    hidden();
    expect(reads).toBe(0);
    expect(calls).toHaveLength(1);
    await render(<BoardReportQueue key="sparse" {...props} reports={[]} targets={[]} revisions={[]} />);
    expect(host.textContent).toContain(m.moderation_queue_empty_next());
    expect(host.querySelector('details, article, textarea')).toBeNull();
    await click(host, m.threads_next_page(), flush);
    expect(next).toEqual([cursor, cursor]);
    expect(reads).toBe(0);
  });
});

test('unavailable revision stays undisclosed and current target gates/labels remain independent from the report reference and Back', async () => {
  await withDom(async ({ host, render }) => {
    const { ModerationReportsView } = await import('../src/moderation/reports-page');
    let actions = 0;
    let reads = 0;
    for (const availability of ['withheld', 'erased', 'unavailable']) {
      await render(
        <ModerationReportsView
          key={availability}
          boardId="community"
          reports={[report]}
          targets={[
            { ...target, value: { post: { id: report.target.id, availability, body: 'PRIVATE_CURRENT_BODY' } } },
          ]}
          revisions={[{ reportId: report.id, value: null }]}
          next={null}
          onAction={async () => {
            actions++;
          }}
          onRefresh={async () => {
            reads++;
          }}
        />,
      );
      expect(host.querySelector('h1')?.textContent).toBe(m.moderation_reports_heading());
      const back = [...host.querySelectorAll('a')].find((node) => node.textContent === m.moderation_queue_back())!;
      expect(back.getAttribute('href')).toMatch(/\/boards\/community$/);
      expect(back.className).toContain('min-h-11');
      expect(back.closest('form, details')).toBeNull();
      expect(host.querySelector('code')?.textContent).toBe(report.target.id);
      expect(host.textContent).toContain(report.evidence!);
      expect(host.textContent).toContain(m.moderation_target_unavailable());
      expect(host.innerHTML).not.toContain(report.revisionId!);
      expect(host.innerHTML).not.toContain('PRIVATE_CURRENT_BODY');
      expect(host.querySelector(`a[href*="${report.target.id}"]`)).toBeNull();
      const { details } = reference(host);
      expect(details.contains(back)).toBe(false);
      expect(actions).toBe(0);
      expect(reads).toBe(0);
    }
  });
});
