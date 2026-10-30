import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderQueue } from '../src/features/import-review/provider-queue-view';
import {
  decideProviderCandidate,
  validQueueDecision,
  validQueueScope,
} from '../src/features/import-review/provider-queue';
import { providerQueueFixture } from '../src/kernel/fake/provider-review-queue';
import { m } from '../src/paraglide/messages.js';

test('preparation, bounded continuation, truthful empty and denial remain distinct visible outcomes', async () => {
  for (const [scenario, text] of [
    ['preparing', m.prq_preparing()],
    ['empty', m.prq_empty()],
    ['denied', m.prq_denied()],
    ['unavailable', m.prq_unavailable()],
  ] as const) {
    const fixture = providerQueueFixture(scenario);
    const markup = renderToStaticMarkup(
      createElement(ProviderQueue, {
        transport: fixture.transport,
        initial: fixture.initial,
        initialScope: fixture.scope,
      }),
    );
    expect(markup).toContain(text);
    expect(markup).not.toContain(fixture.native.candidate.id);
  }
  const fixture = providerQueueFixture('preparing');
  expect(await fixture.transport.read(fixture.scope)).toEqual({ state: 'preparing', next: 'opaque-continuation' });
  expect((await fixture.transport.read(fixture.scope, 'opaque-continuation')).state).toBe('ready');
  expect(fixture.calls.some((call) => call.path.includes('cursor=opaque-continuation'))).toBe(true);
});

test('generated native calls retain exact Context, head, session and retry key without adopting', async () => {
  const fixture = providerQueueFixture();
  const command = {
    ...fixture.scope,
    context: '019a1b2c-3d4e-7000-8000-001000000001',
    subject: fixture.native.id,
    candidate: fixture.native.candidate.id,
    operation: 'accept' as const,
    head: 7,
    key: crypto.randomUUID(),
    session: 'observed-session',
  };
  expect(validQueueDecision(command)).toBe(true);
  await decideProviderCandidate(fixture.client, 'Bearer reviewer', command);
  await decideProviderCandidate(fixture.client, 'Bearer reviewer', command);
  expect(fixture.calls.map((call) => call.body)).toEqual([
    { context: command.context, expected_head: 7 },
    { context: command.context, expected_head: 7 },
  ]);
  expect(
    fixture.calls.every(
      (call) =>
        call.path.endsWith(':accept') &&
        call.authorization === 'Bearer reviewer' &&
        call.session === 'observed-session',
    ),
  ).toBe(true);
  expect(fixture.calls.map((call) => call.key)).toEqual([JSON.stringify(command.key), JSON.stringify(command.key)]);
  expect(validQueueScope({ ...fixture.scope, source: 'Bad Provider' })).toBe(false);
  expect(validQueueScope({ ...fixture.scope, extra: true })).toBe(false);
  expect(validQueueDecision({ ...command, operation: 'adopt' })).toBe(false);
});
