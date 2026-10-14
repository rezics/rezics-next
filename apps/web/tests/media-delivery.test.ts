import { expect, test } from 'bun:test';
import { forwardToMain } from '../features/api/bff.ts';
import { MediaMetadataError, mediaMetadataOf, resolveMediaMetadata } from '../features/api/media-metadata.ts';

const representation = '00000000-0000-4000-8000-000000000001';
const closedUse = '00000000-0000-4000-8000-000000000002';
const publicUse = '00000000-0000-4000-8000-000000000003';
const person = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const ref = (use: string) => ({ representationId: representation, mediaUseId: use });
const descriptor = (use: string) => ({ status: 'available' as const, representation, use,
  url: `/v1/media/representations/${representation}/bytes?use=${use}`,
  nsfw: 'sfw' as const, ageRating: { status: 'unassessed' as const }, conceal: false });

test('closed occurrences cannot borrow a surviving independent Use of the same representation', () => {
  const answer = mediaMetadataOf([{ status: 'unavailable' }, descriptor(publicUse)], [ref(closedUse), ref(publicUse)], person);
  expect(answer).toHaveLength(1);
  expect(answer[0]).toMatchObject(ref(publicUse));
  expect(answer[0]?.src).toContain(`use=${publicUse}`);
  expect(new URL(answer[0]!.src!, 'http://web.local').searchParams.get('actingSubject')).toBe(person);
  expect(() => mediaMetadataOf([descriptor(publicUse)], [ref(closedUse)])).toThrow('Unexpected image metadata reference');
  expect(() => mediaMetadataOf([{ ...descriptor(closedUse), url: descriptor(publicUse).url }], [ref(closedUse)]))
    .toThrow('Unexpected image delivery reference');
});

test('descriptor URLs cannot borrow an embedded acting Person', () => {
  const item = { ...descriptor(publicUse), url: `${descriptor(publicUse).url}&actingSubject=borrowed-person` };
  const src = (actor?: string) => new URL(mediaMetadataOf([item], [ref(publicUse)], actor)[0]!.src!, 'http://web.local');
  expect(src().searchParams.has('actingSubject')).toBe(false);
  expect(src(person).searchParams.getAll('actingSubject')).toEqual([person]);
});

test('bare representations retain Main availability rather than inheriting a closed occurrence', () => {
  const bare = { representationId: representation };
  const item = { ...descriptor(publicUse), use: null, url: `/v1/media/representations/${representation}/bytes` };
  expect(mediaMetadataOf([{ status: 'unavailable' }], [bare], person)).toEqual([]);
  const [available] = mediaMetadataOf([item, { status: 'unavailable' }], [bare, ref(closedUse)], person);
  expect(available?.mediaUseId).toBeUndefined();
  expect(new URL(available!.src!, 'http://web.local').searchParams.has('use')).toBe(false);
});

test('metadata uses the typed browser session client with the exact acting Person and no role inference', async () => {
  for (const actingSubject of [undefined, person]) {
    const send = (async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/api/main/v1/media/metadata');
      expect(init?.credentials).toBe(actingSubject ? 'same-origin' : 'omit');
      expect(init?.cache).toBe('no-store');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({ items: [{ representation, use: closedUse }],
        ...(actingSubject ? { actingSubject } : {}) });
      return Response.json({ items: [{ status: 'unavailable', reference: { representation, use: closedUse } }] });
    }) as typeof fetch;
    expect(await resolveMediaMetadata([ref(closedUse)], actingSubject, send)).toEqual([]);
  }
});

test('metadata preserves HTTP problems and retry headers; only 202 means pending', async () => {
  for (const status of [202, 400, 401, 403, 404, 409, 429, 503]) {
    const problem = { type: 'https://rezics.com/problems/media_unavailable', code: 'media_unavailable', title: 'Media is unavailable', status };
    const send = (async () => Response.json(problem, { status, headers: { 'retry-after': '7' } })) as unknown as typeof fetch;
    const error = await resolveMediaMetadata([ref(closedUse)], person, send).catch(value => value);
    expect(error).toBeInstanceOf(MediaMetadataError);
    expect(error.status).toBe(status);
    expect(error.problem).toEqual(problem);
    expect(error.headers.get('retry-after')).toBe('7');
    expect(error.pending).toBe(status === 202);
  }
});

test('an empty mounted set sends no invalid empty metadata batch', async () => {
  expect(await resolveMediaMetadata([], person, (() => { throw new Error('Unexpected fetch'); }) as unknown as typeof fetch)).toEqual([]);
});

test('media proxy preserves conditional delivery, denial problems and exact session identity for every persona', async () => {
  for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator']) {
    const token = persona === 'visitor' ? undefined : `${persona}-actual-bearer`;
    const actor = token ? `&actingSubject=${encodeURIComponent(person)}` : '';
    for (const status of [200, 202, 304, 401, 403, 404, 429]) {
      const path = `/v1/media/representations/${representation}/bytes?use=${closedUse}${actor}`;
      const problem = { type: 'https://rezics.com/problems/media_unavailable', code: 'media_unavailable', title: 'Media is unavailable', status };
      const validators = status === 200 || status === 304;
      const upstream = new Headers({ 'cache-control': validators ? 'public, no-cache' : 'no-store',
        'retry-after': '7', 'content-type': validators ? 'image/png' : 'application/problem+json' });
      if (validators) { upstream.set('etag', '"original-digest"'); upstream.set('last-modified', 'Wed, 14 Oct 2026 00:00:00 GMT'); }
      const response = await forwardToMain(new Request(`http://web.local/api/main${path}`, {
        headers: { 'if-none-match': '"original-digest"', authorization: 'Bearer borrowed-token' },
      }), ['v1', 'media', 'representations', representation, 'bytes'], {
        mainOrigin: 'http://main.local', accessToken: token,
        fetch: (async (input, init) => {
          expect(String(input)).toBe(`http://main.local${path}`);
          const headers = new Headers(init?.headers);
          expect(headers.get('authorization')).toBe(token ? `Bearer ${token}` : null);
          expect(headers.get('if-none-match')).toBe('"original-digest"');
          return new Response(status === 304 ? null : validators ? new Uint8Array([33, 150, 83]) : JSON.stringify(problem),
            { status, headers: upstream });
        }) as typeof fetch,
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('etag')).toBe(validators ? '"original-digest"' : null);
      expect(response.headers.has('last-modified')).toBe(validators);
      expect(response.headers.get('retry-after')).toBe('7');
      if (status === 304) expect((await response.arrayBuffer()).byteLength).toBe(0);
      else if (validators) expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([33, 150, 83]));
      else expect(await response.json()).toEqual(problem);
    }
  }
});
