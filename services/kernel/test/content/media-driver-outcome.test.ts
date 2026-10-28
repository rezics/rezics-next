import { expect, test } from 'bun:test';
import type { Outcome } from '../../../../specs/content-media-driver.ts';

type Classifier = (response: Response, method: string, path: string, invalid?: boolean) => Promise<Outcome>;
const mediaDriver = (await import('./media-driver.ts')) as unknown as { classifyMediaOutcome: Classifier };

function problem(status: number, code?: string): Response {
  return Response.json(
    {
      type: 'https://rezics.com/problems/test',
      title: 'Fixture problem',
      status,
      ...(code === undefined ? {} : { code }),
      detail: 'The fixture problem body',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

test("a media route's 5xx or undocumented status is an error, never a denial", async () => {
  for (const status of [500, 503, 599, 418, 299]) {
    await expect(mediaDriver.classifyMediaOutcome(problem(status), 'POST', '/v1/media')).rejects.toThrow(
      `POST /v1/media (${status}):`,
    );
    await expect(mediaDriver.classifyMediaOutcome(problem(status), 'POST', '/v1/media')).rejects.toThrow(
      'The fixture problem body',
    );
  }
});

test('documented refusal statuses are denials and documented validation statuses are invalid', async () => {
  for (const status of [401, 403, 404]) {
    expect(await mediaDriver.classifyMediaOutcome(problem(status), 'POST', '/v1/media')).toBe('denied');
  }
  await expect(mediaDriver.classifyMediaOutcome(problem(409), 'POST', '/v1/threads')).rejects.toThrow(
    'POST /v1/threads (409):',
  );
  expect(await mediaDriver.classifyMediaOutcome(problem(409, 'media_unavailable'), 'POST', '/v1/threads')).toBe(
    'denied',
  );
  await expect(
    mediaDriver.classifyMediaOutcome(problem(409, 'idempotency_conflict'), 'POST', '/v1/threads'),
  ).rejects.toThrow('POST /v1/threads (409):');
  await expect(mediaDriver.classifyMediaOutcome(problem(409), 'POST', '/v1/media')).rejects.toThrow(
    'POST /v1/media (409):',
  );
  await expect(mediaDriver.classifyMediaOutcome(problem(409), 'GET', '/v1/media/media-id')).rejects.toThrow(
    'GET /v1/media/media-id (409):',
  );
  for (const status of [400, 422]) {
    expect(await mediaDriver.classifyMediaOutcome(problem(status), 'POST', '/v1/media', true)).toBe('invalid');
    await expect(mediaDriver.classifyMediaOutcome(problem(status), 'POST', '/v1/media')).rejects.toThrow(
      `POST /v1/media (${status}):`,
    );
  }
});

test('a documented thread creation conflict is an error rather than a media denial', async () => {
  await expect(mediaDriver.classifyMediaOutcome(problem(409, 'conflict'), 'POST', '/v1/threads')).rejects.toThrow(
    'POST /v1/threads (409):',
  );
});
