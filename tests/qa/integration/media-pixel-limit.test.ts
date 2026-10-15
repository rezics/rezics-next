import { expect, test } from 'bun:test';
import { png, sha, startMediaStack } from './media-support.ts';

test('an uploader gets a durable refusal for a tiny original with excessive pixels and no stored bitmap', async () => {
  const stack = await startMediaStack('media-pixel-limit');
  try {
    const owner = await stack.member('uploader');
    const bytes = png(16_384, 16_384, 0);
    expect(bytes.length).toBe(33);
    const reserved = await owner.send('POST', '/v1/media/uploads', {
      profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
      sha256: sha(bytes), disclosure: 'private', actingSubject: owner.actor,
    });
    expect(reserved.status).toBe(201);
    const reservation = await reserved.json() as { asset: string; upload: string;
      quarantineKey: string; objectNamespace: string };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await stack.call('PUT', `/v1/media/uploads/${reservation.upload}/bytes`, {
        token: owner.token, raw: bytes,
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ status: 'rejected', reason: 'format-rejected',
        representation: null, revision: null });
    }
    const retained = await owner.read(`/v1/media/uploads/${reservation.upload}`);
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ status: 'rejected', reason: 'format-rejected' });
    expect((await stack.contentPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM media.representation WHERE asset_id = $1', [reservation.asset])).rows[0]!.n).toBe(0);
    await expect(stack.objects(reservation.objectNamespace).get(sha(bytes))).rejects.toThrow();
    await expect(stack.objects(`${reservation.quarantineKey}/`).get(sha(bytes))).rejects.toThrow();
  } finally {
    await stack.stop();
  }
}, 120_000);
