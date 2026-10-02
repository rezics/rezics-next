import { expect, test } from 'bun:test';
import { imageReferenceFromUrl, resolveMediaMetadata } from '../features/api/media-metadata.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('selected media resolves canonical identities while retaining its request cache grain', async () => {
  const ref = imageReferenceFromUrl(`/api/main/v1/media/avatars/${id(1)}?actingSubject=person`)!;
  let request: Record<string, unknown> | undefined;
  const send = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body));
    return Response.json({ items: [{ status: 'available', representation: id(2), use: id(3),
      url: `/v1/media/representations/${id(2)}/bytes?use=${id(3)}`, nsfw: 'nsfw',
      ageRating: { status: 'unassessed' }, conceal: false, controls: { conceal: null }, canEdit: true }] });
  }) as unknown as typeof fetch;
  const [image] = await resolveMediaMetadata([ref], 'person', send);
  expect(request?.items).toEqual([{ selection: id(1) }]);
  expect(image).toMatchObject({ representationId: id(2), mediaUseId: id(3), requestKey: `selection:${id(1)}:` });
  expect(image?.src).toContain('actingSubject=person');
  expect(image?.controls?.conceal).toBeUndefined();
});

test('direct image Uses stay distinct and incomplete metadata cannot silently succeed', async () => {
  const ref = imageReferenceFromUrl(`/v1/media/representations/${id(2)}/bytes?use=${id(3)}`)!;
  expect(ref).toEqual({ representationId: id(2), mediaUseId: id(3) });
  for (const origin of ['https://rezics.com', '//rezics.com', 'HTTPS://rezics.com', 'https://a.b.rezics.com/discard/..']) {
    expect(imageReferenceFromUrl(`${origin}/v1/media/representations/${id(2)}/bytes?use=${id(3)}`)).toEqual(ref);
  }
  expect(imageReferenceFromUrl(`https://example.org/v1/media/representations/${id(2)}/bytes`)).toBeUndefined();
  const send = (async () => Response.json({ items: [] })) as unknown as typeof fetch;
  await expect(resolveMediaMetadata([ref], null, send)).rejects.toThrow('Incomplete');
  await expect(resolveMediaMetadata(Array.from({ length: 65 }, () => ref), null, send)).rejects.toThrow('64');
});
