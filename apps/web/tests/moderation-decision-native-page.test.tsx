import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionPageView } from '../src/moderation/decision-page';
import { m } from '../src/paraglide/messages.js';
import { decisionNow, openDecision } from '../src/stories/patterns/moderation-decision/fixtures';

test('the installed generated decision fields keep optional context and appeal advice closed', () => {
  const markup = renderToStaticMarkup(createElement(DecisionPageView, { page: openDecision, now: decisionNow }));
  expect(markup).toContain(openDecision.decision.statement);
  expect(markup).toContain(m.decision_target_context_unavailable());
  expect(markup).toContain(m.decision_appeal_advice_unavailable());
  expect(markup).not.toContain('appeal-statement');
  expect(markup).not.toContain(`/threads/${openDecision.decision.targetId}`);
});
