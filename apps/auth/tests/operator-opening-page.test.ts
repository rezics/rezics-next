import { expect, test } from 'bun:test';
import {
  parseOperatorOpeningPage,
  requestOperatorOpeningPage,
  sameOpeningPage,
  type OpeningInput,
} from '../src/operator-session-opening';

const viewer = '11111111-1111-4111-8111-111111111111';
const operator = '22222222-2222-4222-8222-222222222222';
const subject = '33333333-3333-4333-8333-333333333333';
const reservation = '44444444-4444-4444-8444-444444444444';
const input: OpeningInput = {
  accountId: viewer,
  operationKey: 'opening-review',
  operation: { kind: 'opening', operatorAccountId: operator, subjectAccountId: subject },
};
const observation = {
  stage: 'current',
  viewer: { accountId: viewer },
  subject: { id: subject, kind: 'actor' },
  operator: { id: operator, kind: 'organization' },
  relation: { reservationId: reservation, version: '7' },
  disclosure: 'unavailable',
  allowedActions: ['opening'],
};

test('opening page accepts only the exact current viewer, relation and action without inventing labels', () => {
  const parsed = parseOperatorOpeningPage(observation, input);
  expect(parsed).toEqual({
    kind: 'ready',
    metadata: {
      viewer: { accountId: viewer, publicLabel: null },
      subject: { id: subject, kind: 'actor', publicLabel: null },
      operator: { id: operator, kind: 'organization', publicLabel: null },
      relation: { reservationId: reservation, version: '7' },
    },
  });
  for (const changed of [
    { ...observation, viewer: { accountId: operator } },
    { ...observation, subject: { ...observation.subject, id: viewer } },
    { ...observation, operator: { ...observation.operator, id: viewer } },
    { ...observation, relation: { ...observation.relation, version: '08' } },
    { ...observation, allowedActions: ['opening', 'transfer'] },
    { ...observation, subject: { ...observation.subject, label: 'Unadmitted label' } },
    { ...observation, authorization: true },
  ])
    expect(parseOperatorOpeningPage(changed, input)).toEqual({ kind: 'unavailable' });

  expect(parsed.kind).toBe('ready');
  if (parsed.kind === 'ready')
    expect(
      sameOpeningPage(parsed.metadata, {
        ...parsed.metadata,
        relation: { reservationId: reservation, version: '8' },
      }),
    ).toBe(false);
});

test('the page request makes one cookie-bound observation with only the selected IDs', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((resource, init) => {
    calls.push({ url: resource.toString(), init });
    return Promise.resolve(Response.json(observation));
  }) as typeof fetch;
  try {
    const request = new Request('https://pages.test/_serverFn/opening', {
      method: 'POST',
      headers: { origin: 'https://pages.test', cookie: 'rezics.session=human' },
    });
    expect(await requestOperatorOpeningPage(input, request, 'https://auth.test')).toEqual(
      parseOperatorOpeningPage(observation, input),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://auth.test/account-management/operators/opening-page');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ subjectAccountId: subject, operatorAccountId: operator });
    expect((calls[0]!.init?.headers as Record<string, string>).Cookie).toBe('rezics.session=human');
    expect((calls[0]!.init?.headers as Record<string, string>).Origin).toBe('https://auth.test');

    const refused = new Request('https://pages.test/_serverFn/opening', {
      method: 'POST',
      headers: { origin: 'https://foreign.test' },
    });
    expect(await requestOperatorOpeningPage(input, refused, 'https://auth.test')).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
