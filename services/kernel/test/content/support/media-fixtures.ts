import { createHash } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import sharp, { type Metadata } from 'sharp';
import type { ImageFixture, Source, Container } from '../../../../../specs/content-media-driver.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { threadTarget } from '../../../src/content/commands.ts';
import { partitionOf } from '../../../src/route/route.ts';
import type { ContentSystem } from './system.ts';

export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function embeddedMetadata(metadata: Metadata): string[] {
  const fields = ['exif', 'xmp', 'icc', 'iptc', 'orientation'] as const;
  const found: string[] = fields.filter((field) => metadata[field] !== undefined);
  // Sharp returns the actual EXIF bytes; a GPS IFD pointer identifies its GPS directory.
  if (metadata.exif) {
    const bytes = metadata.exif;
    const base = bytes.subarray(0, 6).toString() === 'Exif\0\0' ? 6 : 0;
    const little = bytes.toString('ascii', base, base + 2) === 'II';
    const u16 = (offset: number) => (little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset));
    const u32 = (offset: number) => (little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
    const ifd = base + u32(base + 4);
    const entries = u16(ifd);
    for (let index = 0; index < entries; index++) if (u16(ifd + 2 + index * 12) === 0x8825) found.push('gps');
  }
  return found.sort();
}

export async function imageSource(kind: ImageFixture): Promise<Source> {
  if (kind === 'malformed') {
    const bytes = new TextEncoder().encode('This is not an image.');
    return { bytes, sha256: digest(bytes), type: 'image/jpeg', orientedWidth: 0, orientedHeight: 0, metadata: [] };
  }
  const [width, height] =
    kind === 'over-pixel'
      ? [6401, 6400]
      : kind === 'oriented-gps'
        ? [1200, 800]
        : kind === 'tiny'
          ? [127, 61]
          : [3000, 1500];
  let image = sharp({ create: { width: width!, height: height!, channels: 3, background: '#b52e64' } });
  if (kind === 'oriented-gps' || kind === 'tiny') {
    image = image.withMetadata({ orientation: kind === 'oriented-gps' ? 6 : 1 }).withExifMerge({
      IFD0: { Artist: 'Private photographer' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '25/1 2/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '121/1 3/1 0/1' },
    });
    if (kind === 'oriented-gps')
      image = image.withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">Private location</x:xmpmeta>');
  }
  const full = await image.jpeg().toBuffer();
  const metadata = await sharp(full, { limitInputPixels: false }).metadata();
  const bytes = kind === 'truncated' ? full.subarray(0, Math.min(1024, Math.floor(full.length / 2))) : full;
  return {
    bytes: Uint8Array.from(bytes),
    sha256: digest(bytes),
    type: 'image/jpeg',
    orientedWidth: metadata.autoOrient.width,
    orientedHeight: metadata.autoOrient.height,
    metadata: embeddedMetadata(metadata),
  };
}

/** Provision the real Realm board and its catalogue grants through Kernel HTTP. */
export async function provisionMediaContainers(system: ContentSystem): Promise<{
  containers: { thread: Container; sibling: Container; remote: Container };
  posts: Map<string, { id: string; revisionId: string }>;
}> {
  const author = system.actors.author;
  await bootstrapRelease(system.database.pool, bundledRelease);
  async function command(path: string, body: Record<string, unknown>, method = 'POST', match?: string) {
    const { response } = await system.transport.capture(
      new Request(`https://content.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${author.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          ...(match ? { 'if-match': JSON.stringify(match) } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok)
      throw new Error(`Media fixture ${method} ${path} failed (${response.status}): ${await response.text()}`);
    return response.json();
  }
  const { space } = await command('/v1/spaces', { title: 'Media fixture space' });
  const { realm } = await command('/v1/realms', {
    spaceId: space.spaceId,
    title: 'Media fixture realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  const { subject: scheme } = await command('/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Media fixture scheme' },
  });
  const { subject: concept } = await command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Media fixture concept' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  await command(`/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, 'PUT', realm.headRevisionId);
  const { board } = await command(`/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Media fixture board',
    visibility: 'published',
  });
  const posts = new Map<string, { id: string; revisionId: string }>();
  async function create(key: string): Promise<Container> {
    const { response } = await system.transport.capture(
      new Request('https://content.test/v1/threads', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${author.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(key),
        },
        body: JSON.stringify({
          title: 'Media fixture thread',
          body: fromPlainText('Media fixture post'),
          licence: 'MIT',
          subjectIds: [],
          boardId: board.id,
          visibility: 'published',
        }),
      }),
    );
    if (response.status !== 201)
      throw new Error(`Media fixture thread creation failed (${response.status}): ${await response.text()}`);
    const { thread } = await response.json();
    posts.set(thread.id, { id: thread.firstPost.id, revisionId: thread.firstPost.revisionId });
    return { id: thread.id, route: thread.route, partition: partitionOf(thread.route) };
  }
  const key = 'media-thread';
  const home = threadTarget(system.routeKey, author.actor.accountId, key);
  let siblingKey: string | undefined;
  let remoteKey: string | undefined;
  for (let i = 0; i < 100_000 && (!siblingKey || !remoteKey); i++) {
    const candidate = `media-neighbour-${i}`;
    const target = threadTarget(system.routeKey, author.actor.accountId, candidate);
    if (partitionOf(target.route) === partitionOf(home.route)) siblingKey ??= candidate;
    else remoteKey ??= candidate;
  }
  if (!siblingKey || !remoteKey) throw new Error('Could not anchor media fixture containers');
  return {
    containers: { thread: await create(key), sibling: await create(siblingKey), remote: await create(remoteKey) },
    posts,
  };
}
