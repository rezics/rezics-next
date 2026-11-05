import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import {
  decisionNow,
  openDecision,
  resolvedDecision,
  unsupportedDecision,
} from '../src/stories/patterns/moderation-decision/fixtures';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { DecisionPageView } = await import('../src/moderation/decision-page');
const { loadDecisionPage, decisionReadAdapters } = await import('../src/moderation/decision-read');

test('the generated composed response renders the producer context variants independently of its receipt in eight locales', async () => {
  const restored = resolvedDecision('reversed').decision;
  const originalLocale = getLocale();
  let calls = 0;
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      for (const state of ['available', 'concealed', 'unavailable'] as const) {
        const response = { ...restored, targetContext: state === 'available' ? restored.targetContext : { state } };
        const client = createKernelClient('https://kernel.test', {
          fetch: async (url, init) => {
            expect(String(url)).toBe(`https://kernel.test/v1/moderation-decisions/${restored.id}`);
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer original');
            calls++;
            return Response.json(response, { headers: { [SESSION_HEADER]: 'opaque-final-native-source' } });
          },
        });
        const page = await loadDecisionPage(
          restored.id,
          decisionReadAdapters(client, 'Bearer original'),
          openDecision.viewerId,
        );
        expect(page).not.toBeNull();
        expect(JSON.stringify(page)).not.toContain('opaque-final-native-source');
        const markup = renderToStaticMarkup(createElement(DecisionPageView, { page: page!, now: decisionNow }));
        expect(markup).toContain(restored.statement);
        expect(markup).toContain(m.decision_appeal_reversed());
        if (state === 'available') {
          expect(markup).toContain('Current context after reversal');
          expect(markup).toContain(`/${locale}/threads/original-thread/`);
          expect(markup).toContain(`/boards/current-board`);
        } else {
          expect(markup).toContain(
            state === 'concealed' ? m.decision_target_concealed() : m.decision_target_context_unavailable(),
          );
          expect(markup).not.toContain('Current context after reversal');
          expect(markup).not.toContain('/threads/');
        }
        expect(markup).not.toContain('appeal-statement');
      }
    }
    expect(calls).toBe(locales.length * 3);
  } finally {
    setLocale(originalLocale, { reload: false });
  }
});

test('only native permitted advice and browser admission admit appeals regardless of authorship, readability or browser time', () => {
  for (const page of [
    openDecision,
    unsupportedDecision,
    ...(['not_affected_author', 'already_appealed', 'deadline_passed', 'command_unavailable'] as const).map(
      (reason) => ({
        ...openDecision,
        decision: {
          ...openDecision.decision,
          viewer: { ...openDecision.decision.viewer, appeal: { state: 'unavailable' as const, reason } },
        },
      }),
    ),
  ]) {
    for (const admitted of [true, false]) {
      const markup = renderToStaticMarkup(
        createElement(DecisionPageView, {
          page,
          now: Date.parse('2036-01-01'),
          canCommand: () => admitted,
          onAppeal: async () => ({ state: 'denied' }),
          onRefresh: async () => page,
        }),
      );
      expect(markup.includes('appeal-statement')).toBe(page.decision.viewer.appeal.state === 'permitted' && admitted);
      expect(markup).toContain(page.decision.statement);
      if (page === unsupportedDecision) expect(markup).toContain(m.decision_appeal_unsupported());
    }
  }
});
