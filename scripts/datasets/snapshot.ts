import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Acquisition, MissingRemote, RemoteUnavailable } from './network.ts';
import { atomicJson, blobPath, canonical, sha256, verifiedBlob } from './store.ts';
import type { DatasetSnapshot, DatasetSource, StoredImage } from './types.ts';

export type ImageMode = 'none' | 'covers' | 'all';
function identity(
  snapshot: Pick<DatasetSnapshot, 'format' | 'sources' | 'captures' | 'images'>,
): string {
  return sha256(
    canonical({
      format: snapshot.format,
      sources: snapshot.sources,
      captures: snapshot.captures.map(({ url, digest, bytes, mediaType }) => ({
        url,
        digest,
        bytes,
        mediaType,
      })),
      images: snapshot.images.map((image) => ({
        ...image,
        capture: image.capture
          ? {
              url: image.capture.url,
              digest: image.capture.digest,
              bytes: image.capture.bytes,
              mediaType: image.capture.mediaType,
            }
          : null,
      })),
    }),
  );
}

export function checkSources(sources: readonly DatasetSource[]): void {
  if (!sources.length || new Set(sources.map((source) => source.provider)).size !== sources.length)
    throw new Error('Duplicate/empty dataset providers');
  for (const source of sources) {
    const keys = new Set(source.records.map((record) => record.key));
    if (!keys.size || keys.size !== source.records.length)
      throw new Error(`${source.provider}: duplicate/empty records`);
    for (const record of source.records) {
      if (
        record.provider !== source.provider ||
        (record.key !== `${record.provider}:${record.kind}:${record.externalId}` &&
          record.key !== `${record.provider}:${record.kind}:${sha256(record.externalId)}`) ||
        !record.title.trim() ||
        !record.language ||
        !record.sourceUrl.startsWith('https://') ||
        !record.data ||
        typeof record.data !== 'object' ||
        Array.isArray(record.data)
      )
        throw new Error(`Invalid dataset record: ${record.key}`);
    }
    if (!source.roots.length || source.roots.some((root) => !keys.has(root)))
      throw new Error(`${source.provider}: missing root`);
    for (const edge of source.edges)
      if (!keys.has(edge.from) || !keys.has(edge.to))
        throw new Error(`Dangling dataset edge: ${edge.from} -> ${edge.to}`);
    for (const image of source.images)
      if (!keys.has(image.record) || !image.url.startsWith('https://'))
        throw new Error(`Invalid dataset image: ${image.url}`);
  }
}

export async function freezeSnapshot(
  acquisition: Acquisition,
  sources: DatasetSource[],
  images: ImageMode,
): Promise<DatasetSnapshot> {
  checkSources(sources);
  const saved: StoredImage[] = [];
  const selected = sources
    .flatMap((source) => source.images)
    .filter(
      (image) =>
        images === 'all' || (images === 'covers' && /^(cover|front|subject)/i.test(image.role)),
    );
  for (const image of selected) {
    try {
      const capture = await acquisition.capture(image.url, { limit: 16 * 1024 * 1024 });
      if (!isImage(readFileSync(blobPath(acquisition.root, capture.digest))))
        throw new Error(`Invalid image response: ${image.url}`);
      saved.push({ ...image, missing: false, capture });
    } catch (error) {
      if (error instanceof MissingRemote) saved.push({ ...image, capture: null, missing: true });
      else if (error instanceof RemoteUnavailable)
        saved.push({
          ...image,
          capture: null,
          missing: false,
          unavailable: { status: error.status },
        });
      else throw error;
    }
  }
  for (const source of sources) {
    source.records.sort((a, b) => a.key.localeCompare(b.key));
    source.roots.sort();
    source.edges.sort((a, b) => canonical(a).localeCompare(canonical(b)));
    source.images.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  const core = {
    format: 'rezics-local-dataset-v1' as const,
    sources: sources.sort((a, b) => a.provider.localeCompare(b.provider)),
    captures: [...acquisition.captures.values()].sort(
      (a, b) => a.url.localeCompare(b.url) || a.digest.localeCompare(b.digest),
    ),
    images: saved.sort((a, b) =>
      canonical([a.record, a.role, a.url]).localeCompare(canonical([b.record, b.role, b.url])),
    ),
  };
  const digest = identity(core),
    id = `dataset-${digest.slice(0, 20)}`;
  const snapshot: DatasetSnapshot = { ...core, digest, id, createdAt: new Date().toISOString() };
  const path = join(acquisition.root, 'snapshots', id, 'snapshot.json');
  if (!existsSync(path)) atomicJson(path, snapshot);
  for (const source of sources)
    atomicJson(join(acquisition.root, `${source.provider}.latest.json`), { id });
  atomicJson(join(acquisition.root, 'latest.json'), { id });
  return readSnapshot(acquisition.root, id);
}

export function readSnapshot(root: string, id: string): DatasetSnapshot {
  if (!/^dataset-[a-f0-9]{20}$/.test(id)) throw new Error('Invalid dataset snapshot ID');
  const value = JSON.parse(
    readFileSync(join(root, 'snapshots', id, 'snapshot.json'), 'utf8'),
  ) as DatasetSnapshot;
  if (
    value.format !== 'rezics-local-dataset-v1' ||
    value.id !== id ||
    identity(value) !== value.digest ||
    id !== `dataset-${value.digest.slice(0, 20)}`
  )
    throw new Error(`Invalid snapshot digest: ${id}`);
  checkSources(value.sources);
  return value;
}

export function latestSnapshot(root: string, provider?: string): DatasetSnapshot {
  const path = join(root, provider ? `${provider}.latest.json` : 'latest.json');
  if (!existsSync(path))
    throw new Error('No local dataset snapshot; run task dataset:fetch explicitly');
  const { id } = JSON.parse(readFileSync(path, 'utf8')) as { id: string };
  return readSnapshot(root, id);
}

export function verifySnapshot(root: string, snapshot: DatasetSnapshot): Record<string, number> {
  checkSources(snapshot.sources);
  if (identity(snapshot) !== snapshot.digest) throw new Error('Snapshot content changed');
  const references = new Map(snapshot.captures.map((capture) => [capture.digest, capture]));
  for (const image of snapshot.images) {
    if (image.capture) references.set(image.capture.digest, image.capture);
    if (image.missing !== (image.capture === null && image.unavailable === undefined))
      throw new Error('Image availability metadata differs');
  }
  for (const capture of references.values()) {
    const bytes = verifiedBlob(root, capture.digest);
    if (bytes.length !== capture.bytes) throw new Error(`Blob length mismatch: ${capture.url}`);
    if (
      snapshot.images.some((image) => image.capture?.digest === capture.digest) &&
      !isImage(bytes)
    )
      throw new Error(`Captured image does not have a supported raster signature: ${capture.url}`);
  }
  return {
    sources: snapshot.sources.length,
    records: snapshot.sources.reduce((sum, source) => sum + source.records.length, 0),
    edges: snapshot.sources.reduce((sum, source) => sum + source.edges.length, 0),
    blobs: references.size,
    images: snapshot.images.filter((image) => image.capture !== null).length,
    missingImages: snapshot.images.filter((image) => image.missing).length,
    unavailableImages: snapshot.images.filter((image) => image.unavailable !== undefined).length,
  };
}
export function isImage(bytes: Uint8Array): boolean {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (data[0] === 255 && data[1] === 216 && data[2] === 255) ||
    data.subarray(0, 6).toString() === 'GIF87a' ||
    data.subarray(0, 6).toString() === 'GIF89a' ||
    (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP')
  );
}
