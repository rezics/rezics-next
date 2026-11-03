import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionPageView } from '../src/moderation/decision-page';
import type { DecisionPage } from '../src/moderation/decision-read';
import { ReporterStatusPage } from '../src/moderation/reporter-status-view';
import type { ReporterStatus } from '../src/moderation/reporter-status-model';
import { m } from '../src/paraglide/messages.js';

const { dirname } = await import('node:path');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

const decidedAt = '2026-10-01T09:30:00.000Z';
const appealDeadline = '2027-04-02T09:30:00.000Z';
const resolvedAt = '2026-10-30T10:15:00.000Z';
const decisionId = 'decision-private-case-1';
const targetId = 'target-private-case-1';
const decisionReason = Array.from(
  { length: 14 },
  (_, index) =>
    `Decision reason paragraph ${index + 1}: the report was reviewed against the community rules and the full context submitted with the original post. This explanation records the reason for removal and remains available in the private case.`,
).join('\n\n');
const appealReview = [
  'The independent reviewer checked the original decision and the complete context available when it was made.',
  'The affected information had been published by its organization for public event enquiries and did not identify a private individual.',
  'The decision was reversed after this separate review, and this complete statement remains attached to that outcome.',
].join('\n\n');
const decisionPage: DecisionPage = {
  viewerId: 'author-private-case-1',
  nativeSourceFingerprint: 'source-private-case-1',
  decision: {
    id: decisionId,
    targetKind: 'post',
    targetId,
    action: 'takedown',
    statement: decisionReason,
    decidedAt,
    appealDeadline,
    appeal: null,
  },
};

const submittedAt = '2026-10-30T10:00:00.000Z';
const reportResolvedAt = '2026-10-31T10:00:00.000Z';
const reportId = 'report-private-case-1';
const reportTargetId = 'reported-target-private-case-1';
const revisionId = 'revision-private-case-1';
const reporterId = 'reporter-private-case-1';
const submittedEvidence = Array.from(
  { length: 14 },
  (_, index) =>
    `Submitted evidence paragraph ${index + 1}: I reported repeated unsolicited advertising in this discussion. This is the complete reason I gave when I submitted the report for review.`,
).join('\n\n');
const privateReporterCase = {
  id: reportId,
  target: { kind: 'post' as const, id: reportTargetId },
  revisionId,
  reason: 'spam' as const,
  evidence: submittedEvidence,
  reporterId,
  createdAt: submittedAt,
  resolvedAt: reportResolvedAt,
  outcome: 'dismissed' as const,
  targetAvailability: 'available' as const,
};

function parseMarkup(markup: string) {
  const window = new Window();
  const host = window.document.createElement('div');
  host.innerHTML = markup;
  return { window, host };
}

function renderDecision(page: DecisionPage) {
  return renderToStaticMarkup(
    createElement(DecisionPageView, {
      page,
      now: Date.parse(appealDeadline),
      onAppeal: async () => ({ state: 'acknowledged', readback: { state: 'unavailable' } }),
      onRefresh: async () => page,
    }),
  );
}

test('private decision cases keep full evidence, named shared frames, independent targets and exact outcome dates', async () => {
  const open = parseMarkup(renderDecision(decisionPage));
  try {
    const { host } = open;
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelectorAll('h2').length).toBeGreaterThanOrEqual(4);
    expect(host.querySelectorAll('[data-content-item-slot="title"]').length).toBeGreaterThanOrEqual(4);
    expect(host.querySelectorAll('.group.relative.isolate').length).toBeGreaterThanOrEqual(4);
    const headings = [...host.querySelectorAll('h2')].map((heading) => heading.textContent?.trim());
    expect(headings).toContain(m.decision_current_outcome());
    expect(headings).toContain(m.decision_original_heading());
    expect(headings).toContain(m.decision_current_target());
    expect(headings).toContain(m.decision_appeal_heading());
    expect(host.querySelector('h3')?.textContent).toBe(m.decision_reasons_heading());
    expect(host.textContent).toContain(decisionReason);
    expect(host.textContent).toContain(m.decision_target_context_unavailable());
    expect(host.textContent).toContain(m.decision_appeal_advice_unavailable());
    expect(host.querySelector(`time[datetime="${decidedAt}"]`)).not.toBeNull();
    expect(host.querySelector(`time[datetime="${appealDeadline}"]`)).not.toBeNull();
    expect(host.querySelector(`a[href*="${targetId}"]`)).toBeNull();
    expect(host.querySelector('form')).toBeNull();
    expect(host.querySelector('textarea')).toBeNull();

    const pendingPage: DecisionPage = {
      ...decisionPage,
      decision: {
        ...decisionPage.decision,
        appeal: { id: 'appeal-pending-1', outcome: null, statement: null, resolvedAt: null },
      },
    };
    const pending = parseMarkup(renderDecision(pendingPage));
    try {
      expect(pending.host.textContent).toContain(m.decision_appeal_pending());
      expect(pending.host.querySelector('form')).toBeNull();
      expect(pending.host.querySelector('textarea')).toBeNull();
    } finally {
      await pending.window.happyDOM.close();
    }

    for (const outcome of ['reversed', 'upheld'] as const) {
      const resolvedPage: DecisionPage = {
        ...decisionPage,
        decision: {
          ...decisionPage.decision,
          appeal: { id: `appeal-${outcome}-1`, outcome, statement: appealReview, resolvedAt },
        },
      };
      const resolved = parseMarkup(renderDecision(resolvedPage));
      try {
        expect(resolved.host.textContent).toContain(decisionReason);
        expect(resolved.host.textContent).toContain(appealReview);
        expect(resolved.host.querySelector(`time[datetime="${resolvedAt}"]`)).not.toBeNull();
        expect(resolved.host.querySelector('form')).toBeNull();
        expect(resolved.host.querySelector('textarea')).toBeNull();
        expect(resolved.host.textContent).toContain(
          outcome === 'reversed' ? m.decision_appeal_reversed() : m.decision_appeal_upheld(),
        );
        expect(resolved.host.textContent).toContain(m.decision_target_context_unavailable());
      } finally {
        await resolved.window.happyDOM.close();
      }
    }
  } finally {
    await open.window.happyDOM.close();
  }
});

test('reporter cases keep full submitted evidence, UTC timeline and identifiers only in the reachable reference', async () => {
  for (const targetAvailability of ['available', 'unavailable'] as const) {
    for (const outcome of [null, 'actioned', 'dismissed'] as const) {
      const report: ReporterStatus = {
        ...privateReporterCase,
        targetAvailability,
        outcome,
        resolvedAt: outcome ? reportResolvedAt : null,
      };
      const reportWithUntrustedExtras = {
        ...report,
        targetBody: 'PRIVATE target body must not appear',
        moderatorNotes: 'PRIVATE moderator notes must not appear',
        otherReports: ['PRIVATE other report must not appear'],
        appeal: { outcome: 'reversed', statement: 'PRIVATE appeal must not appear' },
      } as ReporterStatus;
      const rendered = parseMarkup(
        renderToStaticMarkup(createElement(ReporterStatusPage, { report: reportWithUntrustedExtras })),
      );
      try {
        const { host } = rendered;
        expect(host.querySelectorAll('h1')).toHaveLength(1);
        expect(host.querySelectorAll('h2').length).toBeGreaterThanOrEqual(3);
        expect(host.querySelectorAll('h3').length).toBeGreaterThanOrEqual(2);
        expect(host.querySelectorAll('[data-content-item-slot="title"]').length).toBeGreaterThanOrEqual(5);
        expect(host.querySelectorAll('.group.relative.isolate').length).toBeGreaterThanOrEqual(4);
        const headings = [...host.querySelectorAll('h2')].map((heading) => heading.textContent?.trim());
        expect(headings).toContain(m.reporter_status_timeline());
        expect(headings).toContain(m.reporter_status_submission());
        expect(headings).toContain(m.reporter_status_target());
        expect(host.textContent).toContain(submittedEvidence);
        expect(host.textContent).toContain(m.report_spam());
        expect(host.textContent).toContain(
          outcome === null
            ? m.reporter_status_pending()
            : outcome === 'actioned'
              ? m.moderation_actioned()
              : m.moderation_dismissed(),
        );
        expect(host.textContent).toContain(
          targetAvailability === 'available' ? m.reporter_status_available() : m.moderation_target_unavailable(),
        );
        expect(host.textContent).toContain('UTC');
        expect(host.querySelector(`time[datetime="${submittedAt}"]`)).not.toBeNull();
        if (outcome) expect(host.querySelector(`time[datetime="${reportResolvedAt}"]`)).not.toBeNull();

        const timeline = host.querySelector('ol[aria-label]');
        expect(timeline?.getAttribute('aria-label')).toBe(m.reporter_status_timeline());
        expect(timeline?.querySelectorAll('li')).toHaveLength(2);
        expect(host.querySelectorAll('a')).toHaveLength(1);
        expect(host.querySelector('a')?.getAttribute('href')).toContain('/inbox');
        expect(host.querySelector('form')).toBeNull();
        expect(host.textContent).not.toContain(reporterId);
        expect(host.textContent).not.toContain('PRIVATE target body');
        expect(host.textContent).not.toContain('PRIVATE moderator notes');
        expect(host.textContent).not.toContain('PRIVATE other report');
        expect(host.textContent).not.toContain('PRIVATE appeal');

        const details = host.querySelector('details');
        expect(details?.open).toBe(false);
        expect(details?.querySelector('a')).toBeNull();
        const labels = [...(details?.querySelectorAll('dt') ?? [])].map((label) => label.textContent?.trim());
        const values = [...(details?.querySelectorAll('dd') ?? [])].map((value) => value.textContent?.trim());
        expect(labels).toEqual([
          m.reporter_status_report_id(),
          m.reporter_status_target(),
          m.reporter_status_revision(),
        ]);
        expect(values).toEqual([reportId, `post ${reportTargetId}`, revisionId]);
        expect(details?.querySelector('button')?.closest('a')).toBeNull();

        const visibleCase = host.cloneNode(true) as HTMLElement;
        visibleCase.querySelector('details')?.remove();
        expect(visibleCase.textContent).not.toContain(reportId);
        expect(visibleCase.textContent).not.toContain(reportTargetId);
        expect(visibleCase.textContent).not.toContain(revisionId);
        expect(visibleCase.textContent).not.toContain(reporterId);
      } finally {
        await rendered.window.happyDOM.close();
      }
    }
  }
});
