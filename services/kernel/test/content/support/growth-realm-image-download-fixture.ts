import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createImageJob } from '../../../src/content/image-job.ts';
import { routeOf } from '../../../src/route/route.ts';
import { mediaRealmDownloadFixture } from '../media-realm-download-fixture.ts';

export type RealmImageVariant = Readonly<{
  format: 'avif' | 'webp';
  width: number;
  height: number;
  sha256: string;
  byteCount: number;
  key: string;
}>;

export type GrowthRealmImage = Readonly<{
  id: string;
  reservationRequestId: string;
  bytes: Uint8Array;
  sha256: string;
  variant: RealmImageVariant;
  variantName: string;
}>;

type MediaRealmFixture = Awaited<ReturnType<typeof mediaRealmDownloadFixture>>;

export type GrowthRealmImageDownloadFixture = MediaRealmFixture &
  Readonly<{
    realmId: string;
    spaceId: string;
    route: number;
    image: GrowthRealmImage;
    completionValue: Record<string, unknown>;
    completionReplayValue: Record<string, unknown>;
  }>;

export async function growthRealmImageDownloadFixture(): Promise<GrowthRealmImageDownloadFixture> {
  const base = await mediaRealmDownloadFixture();
  try {
    const realmId = base.protectedRealm.realmId;
    const reader = base.alice;
    const route = routeOf(realmId);
    if (route === null) throw new Error(`Expected a routed Realm identifier: ${realmId}`);

    const anchors = await base.db.admin.query<{ space_id: string; route: number; space_route: number }>(
      `SELECT r.space_id::text AS space_id, r.route, s.route AS space_route
       FROM community.realm r
       JOIN community.space s ON s.route=r.route AND s.space_id=r.space_id
       WHERE r.route=$1 AND r.realm_id=$2 AND r.state='active' AND s.state='active'`,
      [route, realmId],
    );
    const anchor = anchors.rows[0];
    if (anchors.rows.length !== 1 || !anchor || anchor.route !== anchor.space_route)
      throw new Error(`Expected one active Realm and independently anchored Space at route ${route}`);
    const spaceId = anchor.space_id;

    await base.grant(reader.accountId, realmId, ['realm:manage']);
    const readable = await base.readRealm(realmId, reader.bearer);
    if (readable.response.status !== 200) throw new Error(`Realm reader admission failed with ${readable.response.status}`);

    const bytes = Uint8Array.from(
      await sharp({ create: { width: 96, height: 48, channels: 3, background: '#245a91' } })
        .png()
        .toBuffer(),
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reservationRequestId = randomUUID();
    const reservation = await base.checked(
      'POST',
      `/v1/realms/${realmId}/media`,
      { purpose: 'realm-icon', mediaType: 'image/png', byteCount: bytes.byteLength, sha256 },
      201,
      { bearer: reader.bearer, key: reservationRequestId },
    );
    const media = reservation.media as { id: string };
    if (routeOf(media.id) !== route) throw new Error('Native Realm image reservation moved away from its Realm home');

    await base.storage.storage.put(`m/${media.id}/original`, bytes, { mediaType: 'image/png' });
    const completionInput = {
      containerId: realmId,
      reservationRequestId,
      byteCount: bytes.byteLength,
      sha256,
    };
    const completionKey = randomUUID();
    const completionValue = await base.checked(
      'POST',
      `/v1/media/${media.id}:complete`,
      completionInput,
      200,
      { bearer: reader.websiteBearer, key: completionKey },
    );
    const completionReplayValue = await base.checked(
      'POST',
      `/v1/media/${media.id}:complete`,
      completionInput,
      200,
      { bearer: reader.websiteBearer, key: completionKey },
    );

    const published = await createImageJob(base.db.pool, base.storage.storage).process(media.id);
    if (published.state !== 'available' || published.variants.length === 0)
      throw new Error(`Registered Realm image publication ended in ${published.state}`);

    const variants = await base.db.admin.query<RealmImageVariant>(
      `SELECT format, width, height, sha256, byte_count::integer AS "byteCount", key
       FROM content.media_variant WHERE route=$1 AND media_id=$2 ORDER BY format,width`,
      [route, media.id],
    );
    const variant = variants.rows.find((row) => row.format === 'webp') ?? variants.rows[0];
    if (!variant) throw new Error(`Published Realm image ${media.id} has no derivative`);

    return {
      ...base,
      realmId,
      spaceId,
      route,
      image: {
        id: media.id,
        reservationRequestId,
        bytes,
        sha256,
        variant,
        variantName: `${variant.format}-${variant.width}`,
      },
      completionValue: completionValue as Record<string, unknown>,
      completionReplayValue: completionReplayValue as Record<string, unknown>,
    };
  } catch (error) {
    await base.close();
    throw error;
  }
}
