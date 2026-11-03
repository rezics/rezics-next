import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionPageView } from '../src/moderation/decision-page';
import { m } from '../src/paraglide/messages.js';
import { decisionNow, openDecision } from '../src/stories/patterns/moderation-decision/fixtures';

test('keyboard appeal submission stays unavailable until native advice is in the generated response', () => {
  const markup = renderToStaticMarkup(createElement(DecisionPageView, { page: openDecision, now: decisionNow }));
  expect(markup).toContain(m.decision_appeal_advice_unavailable());
  expect(markup).not.toContain('appeal-statement');
  expect(markup).not.toContain('decision_retry_same');
});
