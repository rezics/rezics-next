import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionPageView } from '../src/moderation/decision-page';
import { m } from '../src/paraglide/messages.js';
import {
  availableDecision,
  decisionNow,
  openDecision,
  unavailableAdviceDecision,
  unavailableContextDecision,
  unsupportedBoardDecision,
} from '../src/stories/patterns/moderation-decision/fixtures';

const render = (page: typeof openDecision, now = decisionNow) =>
  renderToStaticMarkup(createElement(DecisionPageView, { page, now }));

test('native advice controls appeal while current context stays optional', () => {
  const concealed = render(openDecision);
  expect(concealed).toContain(m.decision_target_concealed());
  expect(concealed).toContain(openDecision.decision.statement);
  expect(concealed).toContain('appeal-statement');

  const unavailableAdvice = render({
    ...unavailableAdviceDecision,
    viewerId: openDecision.viewerId,
    decision: {
      ...unavailableAdviceDecision.decision,
      targetContext: availableDecision.decision.targetContext,
    },
  });
  expect(unavailableAdvice).toContain(m.decision_appeal_advice_unavailable());
  expect(unavailableAdvice).not.toContain('appeal-statement');

  const unsupported = render(unsupportedBoardDecision);
  expect(unsupported).toContain(m.decision_appeal_unsupported());
  expect(unsupported).not.toContain('appeal-statement');

  const expired = render(openDecision, Date.parse(openDecision.decision.appealDeadline) + 1);
  expect(expired).toContain(m.decision_appeal_expired());
  expect(expired).not.toContain('appeal-statement');
});

test('only a disclosed native destination creates a localized context link', () => {
  const available = render(availableDecision);
  const context = availableDecision.decision.targetContext;
  if (context.state !== 'available' || context.kind !== 'thread') throw new Error('Expected current thread context');
  expect(available).toContain(context.threadTitle!);
  expect(available).toContain(`/threads/${context.threadId}`);
  expect(available).toContain(`#${context.postId}`);

  for (const page of [openDecision, unavailableContextDecision]) {
    const markup = render(page);
    expect(markup).toContain(page.decision.statement);
    expect(markup).not.toContain(`/threads/${page.decision.targetId}`);
  }
  expect(render(unavailableContextDecision)).toContain(m.decision_target_context_unavailable());
});
