import { expect, test } from 'bun:test';
import { fetchOpenLibraryWork, OpenLibraryAcquisitionInvalid,
  OpenLibraryAcquisitionMissing, OpenLibraryAcquisitionUnavailable }
  from '../../../services/main/src/modules/source/open-library.ts';

const id = 'OL45804W';
const bytes = '{"key":"/works/OL45804W","title":"Example","revision":7,"extra":null}';

test('LIVE01/LIVE09: Open Library capture keeps exact response bytes and fixed origin', async () => {
  let called = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    called++;
    expect(url).toBe(`https://openlibrary.org/works/${id}.json`);
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('GET');
    return new Response(bytes, { status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(bytes)), etag: '"rev-7"' } });
  }) as typeof fetch;
  const result = await fetchOpenLibraryWork(id, fetcher);
  expect(called).toBe(1);
  expect(Buffer.from(result.input.rawBytesBase64!, 'base64').toString('utf8')).toBe(bytes);
  expect(result.input).toMatchObject({ provider: 'open-library', namespace: 'work',
    externalId: id, sourceRevision: 'open-library-revision:7',
    coverage: { complete: true }, rightsEvidence: { basis: 'unknown' } });
  expect(result.capture).toMatchObject({ status: 200, etag: '"rev-7"',
    url: `https://openlibrary.org/works/${id}.json` });
  await expect(fetchOpenLibraryWork('https://localhost/private', fetcher))
    .rejects.toBeInstanceOf(OpenLibraryAcquisitionInvalid);
  expect(called).toBe(1);
});

test('LIVE02/LIVE11: failed, redirected, malformed and oversized responses create no capture', async () => {
  const answer = (response: Response) => (async () => response) as typeof fetch;
  await expect(fetchOpenLibraryWork(id, answer(new Response('', { status: 404 }))))
    .rejects.toBeInstanceOf(OpenLibraryAcquisitionMissing);
  for (const response of [
    new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    new Response('not json', { headers: { 'content-type': 'application/json' } }),
    new Response('{"key":"/works/OL1W","title":"Wrong"}',
      { headers: { 'content-type': 'application/json' } }),
    new Response(bytes, { headers: { 'content-type': 'text/html' } }),
    new Response(bytes, { headers: { 'content-type': 'application/json',
      'content-length': '65537' } }),
    new Response(Buffer.alloc(65_537), { headers: { 'content-type': 'application/json' } }),
    new Response(bytes, { headers: { 'content-type': 'application/json',
      'content-length': '1' } }),
  ]) {
    await expect(fetchOpenLibraryWork(id, answer(response)))
      .rejects.toBeInstanceOf(OpenLibraryAcquisitionUnavailable);
  }
  await expect(fetchOpenLibraryWork(id, (async () => { throw new Error('network lost'); }) as typeof fetch))
    .rejects.toBeInstanceOf(OpenLibraryAcquisitionUnavailable);
});
