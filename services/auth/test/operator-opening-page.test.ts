import { expect, test } from 'bun:test';
import type { AuthService } from '../src/index.ts';
import { operatorOpeningPageTransport, OPERATOR_OPENING_PAGE_PATH } from '../src/operator-opening-page.ts';

const issuer = 'https://opening.auth.test';
const service = { verifier: { issuer } } as AuthService;
const subjectAccountId = '00000000-0000-8000-8000-123400000001';
const operatorAccountId = '00000000-0000-8000-8000-123400000002';
const handler = operatorOpeningPageTransport(service, async () => new Response(null, { status: 418 }));
const request = (body: unknown, origin = issuer) =>
  new Request(`${issuer}${OPERATOR_OPENING_PAGE_PATH}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
test('opening advice rejects browser authority and treats absent composition as unavailable', async () => {
  for (const body of [
    { subjectAccountId },
    { subjectAccountId, operatorAccountId, kind: 'actor' },
    { subjectAccountId, operatorAccountId, human: {} },
  ]) {
    expect((await handler(request(body))).status).toBe(400);
  }
  expect((await handler(request({ subjectAccountId, operatorAccountId }, 'https://foreign.test'))).status).toBe(400);
  const response = await handler(request({ subjectAccountId, operatorAccountId }));
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ stage: 'unavailable' });
  expect((await handler(new Request(`${issuer}/adjacent`))).status).toBe(418);
});
