import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { readZonePage, readZonePageForRoute, validateZonePageInput } = await import('../src/zones/zone-read');

const zoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

test('Zone page input accepts exact Subject and supported view targets with bounded native cursors', () => {
  expect(
    validateZonePageInput({
      id: zoneId,
      locale: 'zh-Hant',
      target: { subject: subjectId, view: 'details' },
      cursor: 'next_cursor-1',
      credentialMode: 'session',
    }),
  ).toEqual({
    id: zoneId,
    locale: 'zh-Hant',
    target: { subject: subjectId, view: 'details' },
    cursor: 'next_cursor-1',
    credentialMode: 'session',
  });
  expect(validateZonePageInput({ id: zoneId, locale: 'en', target: { subject: subjectId } }).target).toEqual({
    subject: subjectId,
  });
  expect(validateZonePageInput({ id: zoneId, locale: 'en', target: { route: '' } }).target).toEqual({ route: '' });

  for (const invalid of [
    { target: { subject: subjectId, view: 'unknown' } },
    { target: { subject: subjectId, view: 'details', extra: true } },
    { target: { route: 'guide', view: 'details' } },
    { target: { subject: 'not-a-native-id' } },
    { unexpected: true },
    { locale: 'en-US' },
    { cursor: '!not-a-cursor!' },
    { cursor: 'a'.repeat(4865) },
  ])
    expect(() =>
      validateZonePageInput({
        id: zoneId,
        locale: 'en',
        target: { subject: subjectId },
        ...invalid,
      }),
    ).toThrow();
});

test('native Zone refusal stops before the common Global Subject read', async () => {
  const requests: string[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === `/v1/zones/${zoneId}:readPage`) return Response.json({ code: 'not_found' }, { status: 404 });
      return Response.json({}, { status: 500 });
    }) as typeof fetch,
  });

  const outcome = await readZonePageForRoute(client as never, {
    id: zoneId,
    locale: 'en',
    target: { subject: subjectId, view: 'details' },
  });

  expect(outcome).toEqual({ kind: 'missing' });
  expect(requests).toEqual([`/v1/zones/${zoneId}:readPage`]);
});

test('malformed continuation cursors from the native response are not retained', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async () => Response.json({ next: 'bad/cursor' }, { status: 202 })) as typeof fetch,
  });

  const outcome = await readZonePage(client as never, zoneId, { target: { route: '' } });
  expect(outcome).toEqual({ kind: 'error' });
});
