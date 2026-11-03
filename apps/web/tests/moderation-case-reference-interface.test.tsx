import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModerationAppealsView } from '../src/moderation/appeals-tab';
import type { Appeal } from '../src/moderation/appeals-read';
import { DecisionPageView, DecisionReadStatus } from '../src/moderation/decision-page';
import type { DecisionPage } from '../src/moderation/decision-read';
import { ReporterStatusPage } from '../src/moderation/reporter-status-view';
import type { ReporterStatus } from '../src/moderation/reporter-status-model';
import type { ModerationTarget } from '../src/moderation/target-content';
import { m } from '../src/paraglide/messages.js';

const { dirname } = await import('node:path');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

const createdAt = '2026-10-01T09:30:00.000Z';
const deadline = '2027-04-02T09:30:00.000Z';
const resolvedAt = '2026-10-30T10:15:00.000Z';
const longId = (prefix: string) => `${prefix}-${'reference-'.repeat(12)}`;
const appealId = longId('appeal');
const decisionId = longId('decision');
const targetId = longId('post');
const revisionId = longId('revision');
const reporterId = 'private-reporter-case-owner';
const longDecisionReason = Array.from(
  { length: 10 },
  (_, index) =>
    `Decision reason paragraph ${index + 1}: the original report was reviewed against the community rules and the complete context submitted with the post. This is the full explanation for the recorded outcome.`,
).join('\n\n');
const longAppealReason = Array.from(
  { length: 9 },
  (_, index) =>
    `Appeal statement paragraph ${index + 1}: the author supplied additional context and asks for an independent review of the original decision. This complete human statement remains available.`,
).join('\n\n');
const longReview = [
  'The independent reviewer read the complete original reason and the full additional appeal statement.',
  'The context showed that the event contact information was published by its organization for public enquiries.',
  'The reviewer reversed the original decision and retained this complete explanation with its actual resolution time.',
].join('\n\n');
const appeal: Appeal = {
  id: appealId,
  decisionId,
  appellantId: 'private-author-case-owner',
  statement: longAppealReason,
  createdAt,
  decision: {
    statement: longDecisionReason,
    target: { kind: 'post', id: targetId },
    appeal: null,
  },
  canResolve: true,
};
const withheldTarget: ModerationTarget = { key: `post:${targetId}`, kind: 'post', value: null };
const markedWithheldTarget: ModerationTarget = {
  key: `post:${targetId}`,
  kind: 'post',
  value: { post: { id: targetId, availability: 'withheld', body: 'PRIVATE target body' } },
};
const currentTargetText = 'The current post title and readable body supplied by the page fixture.';
const availableAppealTarget: ModerationTarget = {
  key: `post:${targetId}`,
  kind: 'post',
  value: { post: { id: targetId, body: currentTargetText } },
};
const decisionPage: DecisionPage = {
  viewerId: 'private-author-case-owner',
  nativeSourceFingerprint: 'source-private-author-case',
  decision: {
    id: decisionId,
    targetKind: 'post',
    targetId,
    action: 'takedown',
    statement: longDecisionReason,
    decidedAt: createdAt,
    appealDeadline: deadline,
    appeal: { id: appealId, outcome: 'reversed', statement: longReview, resolvedAt },
    viewer: {
      affectedAuthor: true,
      observedAt: createdAt,
      appeal: { state: 'unavailable', reason: 'already_appealed' },
    },
    targetContext: { state: 'concealed' },
  },
};
const currentTarget = {
  id: targetId,
  authorId: 'private-author-case-owner',
  text: currentTargetText,
  href: `/threads/current-thread#${targetId}`,
};
const currentTargetContext = {
  state: 'available' as const,
  kind: 'thread' as const,
  threadId: 'current-thread',
  postId: targetId,
  boardId: 'current-board',
  threadTitle: currentTargetText,
  boardTitle: null,
};
const privateReport: ReporterStatus = {
  id: longId('report'),
  target: { kind: 'post', id: targetId },
  revisionId,
  reason: 'spam',
  evidence: longAppealReason,
  reporterId,
  createdAt,
  resolvedAt,
  outcome: 'dismissed',
  targetAvailability: 'unavailable',
};

function parseMarkup(markup: string) {
  const window = new Window({ url: 'https://site.test/en/moderation/cases' });
  const host = window.document.createElement('div');
  host.innerHTML = markup;
  window.document.body.append(host);
  return { window, host };
}

function renderDecision(page: DecisionPage, callbacks: { reads: number; commands: number }, width?: number) {
  const view = createElement(DecisionPageView, {
    page,
    now: Date.parse(deadline),
    onAppeal: async () => {
      callbacks.commands++;
      return { state: 'acknowledged', readback: { state: 'unavailable' } };
    },
    onRefresh: async () => {
      callbacks.reads++;
      return page;
    },
  });
  return renderToStaticMarkup(width ? createElement('div', { style: { width: `${width}px` } }, view) : view);
}

test('Moderation cases prioritize human outcomes while exact support references remain reachable', async () => {
  const callbacks = { reads: 0, commands: 0 };
  for (const width of [390, 1280]) {
    const appeals = parseMarkup(
      renderToStaticMarkup(
        createElement(
          'div',
          { style: { width: `${width}px` } },
          createElement(ModerationAppealsView, {
            appeals: [appeal],
            targets: [withheldTarget],
            next: null,
          }),
        ),
      ),
    );
    try {
      const { host, window } = appeals;
      expect(host.firstElementChild?.getAttribute('style')).toContain(`${width}px`);
      expect(host.querySelector('h1')?.textContent).toContain(m.moderation_appeals_heading());
      const appealHeadings = [...host.querySelectorAll('h1, h2, h3')].map((heading) => heading.textContent).join(' ');
      for (const id of [appealId, decisionId, targetId]) expect(appealHeadings).not.toContain(id);
      expect(
        [...host.querySelectorAll('h3')].some((heading) => heading.textContent === m.moderation_current_target_label()),
      ).toBe(true);
      expect(host.textContent).toContain(m.reporter_status_post());
      expect(host.textContent).toContain(m.moderation_target_unavailable());
      expect(host.textContent).not.toContain(targetId);
      expect(host.innerHTML).not.toContain(targetId);
      expect(host.textContent).toContain(longDecisionReason);
      expect(host.textContent).toContain(longAppealReason);
      expect(host.querySelector(`time[datetime="${createdAt}"]`)).not.toBeNull();
      expect(host.querySelector(`a[href*="${targetId}"]`)).toBeNull();
      expect(host.querySelector('blockquote')?.textContent).toBe(m.moderation_target_unavailable());
      expect(host.querySelector('form')).not.toBeNull();
      expect(host.querySelector('form')?.textContent).toContain(m.moderation_appeal_uphold_action());
      expect(host.querySelector('form')?.textContent).toContain(m.moderation_appeal_reverse_action());

      const details = host.querySelector('details');
      expect(details?.open).toBe(false);
      expect(details?.querySelector('summary')?.textContent).toBe(m.reporter_status_reference());
      const referenceValues = [...(details?.querySelectorAll('dd') ?? [])];
      expect(referenceValues.map((value) => value.textContent)).toEqual([appealId, decisionId]);
      for (const value of referenceValues) {
        expect(value.className).toContain('select-text');
        expect(value.className).toContain('break-all');
      }
      const summary = details?.querySelector('summary');
      summary?.focus();
      expect(window.document.activeElement).toBe(summary);
      expect(summary?.tabIndex).toBe(0);
    } finally {
      await appeals.window.happyDOM.close();
    }

    const currentAppeal = parseMarkup(
      renderToStaticMarkup(
        createElement(
          'div',
          { style: { width: `${width}px` } },
          createElement(ModerationAppealsView, {
            appeals: [appeal],
            targets: [availableAppealTarget],
            next: null,
          }),
        ),
      ),
    );
    try {
      const { host } = currentAppeal;
      expect(host.textContent).toContain(m.reporter_status_post());
      expect(host.textContent).toContain(currentTargetText);
      expect([...host.querySelectorAll('details dd')].map((value) => value.textContent)).toEqual([
        appealId,
        decisionId,
        targetId,
      ]);
    } finally {
      await currentAppeal.window.happyDOM.close();
    }

    const markedWithheldAppeal = parseMarkup(
      renderToStaticMarkup(
        createElement(ModerationAppealsView, {
          appeals: [appeal],
          targets: [markedWithheldTarget],
          next: null,
        }),
      ),
    );
    try {
      const { host } = markedWithheldAppeal;
      expect(host.textContent).toContain(m.moderation_target_withheld());
      expect(host.textContent).not.toContain(targetId);
      expect(host.innerHTML).not.toContain(targetId);
      expect(host.textContent).not.toContain('PRIVATE target body');
      expect([...host.querySelectorAll('details dd')].map((value) => value.textContent)).toEqual([
        appealId,
        decisionId,
      ]);
    } finally {
      await markedWithheldAppeal.window.happyDOM.close();
    }

    const withheldDecision = parseMarkup(
      renderDecision(
        {
          ...decisionPage,
          decision: {
            ...decisionPage.decision,
            appeal: { ...decisionPage.decision.appeal!, outcome: 'reversed' },
            targetContext: { state: 'concealed' },
          },
        },
        callbacks,
      ),
    );
    try {
      const { host } = withheldDecision;
      expect(host.firstElementChild?.getAttribute('style')).toBeNull();
      expect(host.querySelector('h1')?.textContent).toContain(m.decision_heading());
      const decisionHeadings = [...host.querySelectorAll('h1, h2, h3')].map((heading) => heading.textContent).join(' ');
      for (const id of [decisionId, targetId, appealId]) expect(decisionHeadings).not.toContain(id);
      expect(host.textContent).toContain(m.reporter_status_post());
      expect(host.textContent).toContain(m.decision_appeal_reversed());
      expect(host.textContent).toContain(longDecisionReason);
      expect(host.textContent).toContain(longReview);
      expect(host.querySelector(`time[datetime="${createdAt}"]`)).not.toBeNull();
      expect(host.querySelector(`time[datetime="${deadline}"]`)).not.toBeNull();
      expect(host.querySelector(`time[datetime="${resolvedAt}"]`)).not.toBeNull();
      expect(host.querySelector(`a[href*="${targetId}"]`)).toBeNull();
      expect(host.textContent).not.toContain('PRIVATE target body');
      expect(host.textContent).not.toContain(currentTarget.text);
      expect(host.textContent).not.toContain(targetId);
      expect(host.innerHTML).not.toContain(targetId);

      const details = host.querySelector('details');
      expect(details?.open).toBe(false);
      expect([...details!.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([decisionId, appealId]);
      for (const value of details!.querySelectorAll('dd')) {
        expect(value.className).toContain('select-text');
        expect(value.className).toContain('break-all');
      }
    } finally {
      await withheldDecision.window.happyDOM.close();
    }

    const currentDecision = parseMarkup(
      renderDecision(
        {
          ...decisionPage,
          decision: {
            ...decisionPage.decision,
            appeal: null,
            viewer: { ...decisionPage.decision.viewer, appeal: { state: 'permitted' } },
            targetContext: currentTargetContext,
          },
        },
        callbacks,
        width,
      ),
    );
    try {
      const { host } = currentDecision;
      const targetLink = host.querySelector(`a[href*="${targetId}"]`);
      expect(targetLink?.textContent).toContain(currentTarget.text);
      expect(targetLink?.closest('form')).toBeNull();
      const refresh = [...host.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(m.decision_refresh()),
      );
      const form = host.querySelector('form');
      expect(refresh).not.toBeNull();
      expect(form).not.toBeNull();
      expect(form?.contains(refresh ?? null)).toBe(false);
      expect(host.querySelector('details')?.closest('form')).toBeNull();
      expect(host.querySelector('h2')?.textContent).toContain(m.decision_current_outcome());
      expect([...host.querySelectorAll('details dd')].map((value) => value.textContent)).toEqual([
        decisionId,
        targetId,
      ]);
      expect(host.querySelector('details dd')?.className).toContain('break-all');
    } finally {
      await currentDecision.window.happyDOM.close();
    }

    const fallbackDecision = parseMarkup(
      renderDecision(
        {
          ...decisionPage,
          decision: {
            ...decisionPage.decision,
            appeal: null,
            viewer: { ...decisionPage.decision.viewer, appeal: { state: 'permitted' } },
            targetContext: { ...currentTargetContext, threadTitle: '' },
          },
        },
        callbacks,
        width,
      ),
    );
    try {
      expect(fallbackDecision.host.textContent).toContain(
        m.decision_target_fallback({ kind: m.reporter_status_post() }),
      );
    } finally {
      await fallbackDecision.window.happyDOM.close();
    }

    const reporter = parseMarkup(
      renderToStaticMarkup(
        createElement(
          'div',
          { style: { width: `${width}px` } },
          createElement(ReporterStatusPage, { report: privateReport }),
        ),
      ),
    );
    try {
      const { host } = reporter;
      expect(host.firstElementChild?.getAttribute('style')).toContain(`${width}px`);
      expect(host.querySelector('h1')?.textContent).toContain(m.reporter_status_heading());
      expect(host.textContent).toContain(m.reporter_status_post());
      expect(host.textContent).toContain(m.moderation_dismissed());
      expect(host.textContent).toContain(longAppealReason);
      expect(host.textContent).toContain(m.decision_target_concealed());
      expect(host.textContent).not.toContain(reporterId);
      expect(host.textContent).not.toContain('PRIVATE target body');
      expect(host.querySelectorAll('a')).toHaveLength(1);
      expect(host.querySelector('a')?.getAttribute('href')).toContain('/inbox');
      expect(host.querySelector(`a[href*="${targetId}"]`)).toBeNull();

      const details = host.querySelector('details');
      expect(details?.open).toBe(false);
      expect([...details!.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([
        privateReport.id,
        `post ${targetId}`,
        revisionId,
      ]);
      expect([...details!.querySelectorAll('dd')].every((value) => value.className.includes('select-text'))).toBe(true);
      expect([...details!.querySelectorAll('dd')].every((value) => value.className.includes('break-all'))).toBe(true);
      expect(details?.querySelector('button')?.textContent).toContain(m.reporter_status_copy());
      const summary = details?.querySelector('summary');
      summary?.focus();
      expect(reporter.window.document.activeElement).toBe(summary);
      expect(summary?.tabIndex).toBe(0);
    } finally {
      await reporter.window.happyDOM.close();
    }
  }

  const loadingAppeals = parseMarkup(
    renderToStaticMarkup(
      createElement(ModerationAppealsView, { appeals: [], targets: [], next: null, state: 'loading' }),
    ),
  );
  try {
    expect(loadingAppeals.host.textContent).toContain(m.moderation_appeals_read_loading());
    expect(loadingAppeals.host.querySelector('details')).toBeNull();
  } finally {
    await loadingAppeals.window.happyDOM.close();
  }

  const refusedDecision = parseMarkup(renderToStaticMarkup(createElement(DecisionReadStatus, { state: 'closed' })));
  try {
    expect(refusedDecision.host.textContent).toContain(m.moderation_decision_read_closed());
    expect(refusedDecision.host.textContent).not.toContain(decisionId);
    expect(refusedDecision.host.querySelector('details')).toBeNull();
  } finally {
    await refusedDecision.window.happyDOM.close();
  }

  const concealedReport = parseMarkup(renderToStaticMarkup(createElement(ReporterStatusPage, { state: 'concealed' })));
  try {
    expect(concealedReport.host.textContent).toContain(m.reporter_status_read_concealed());
    expect(concealedReport.host.textContent).not.toContain(privateReport.evidence!);
    expect(concealedReport.host.querySelector('details')).toBeNull();
  } finally {
    await concealedReport.window.happyDOM.close();
  }

  expect(callbacks.reads).toBe(0);
  expect(callbacks.commands).toBe(0);
});
