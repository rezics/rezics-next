import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Acquisition, MissingRemote, RemoteUnavailable, type Capture } from './network.ts';
import { atomicJson, blobPath, canonical, sha256, verifiedBlob } from './store.ts';
import type { DatasetImage, DatasetSnapshot, DatasetSource, StoredImage } from './types.ts';

export type ImageMode = 'none' | 'covers' | 'all';
function normalizedCaptureRole(image: DatasetImage): 'cover' | 'other' {
  if (image.sourceEvidence) return image.role === 'cover' ? 'cover' : 'other';
  const role = image.role.trim().toLowerCase();
  if (['cover', 'front', 'pkgfront', 'cover:release:pkgfront'].includes(role)) return 'cover';
  if (role.split(',').some((part) => part.trim() === 'front')) return 'cover';
  return 'other';
}

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
    const records = new Map(source.records.map((record) => [record.key, record]));
    const keys = new Set(records.keys());
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
    for (const image of source.images) {
      if (!keys.has(image.record) || !image.url.startsWith('https://'))
        throw new Error(`Invalid dataset image: ${image.url}`);
      if (!image.sourceEvidence) continue;
      const evidence = image.sourceEvidence,
        record = records.get(image.record);
      if (
        image.role !== 'cover' ||
        !record ||
        evidence.provider !== source.provider ||
        evidence.namespace !== record.kind ||
        evidence.externalId !== record.externalId ||
        evidence.sourceUrl !== record.sourceUrl ||
        typeof evidence.sourceName !== 'string' ||
        !evidence.sourceName.trim() ||
        typeof evidence.captureUrl !== 'string' ||
        !evidence.captureUrl.startsWith('https://') ||
        typeof evidence.recordDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(evidence.recordDigest) ||
        typeof evidence.field !== 'string' ||
        !evidence.field.trim() ||
        (evidence.revision !== null &&
          (typeof evidence.revision !== 'string' || !evidence.revision.trim())) ||
        (evidence.holder !== null &&
          (!evidence.holder ||
            typeof evidence.holder.name !== 'string' ||
            !evidence.holder.name.trim() ||
            typeof evidence.holder.field !== 'string' ||
            !evidence.holder.field.trim()))
      )
        throw new Error(`Invalid cover source evidence: ${image.record}`);
    }
  }
}

function jsonPointerValue(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer))
    throw new Error(`Invalid cover field locator: ${pointer}`);
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const part = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(part)) current = current[Number(part)];
    else if (current && typeof current === 'object' && Object.hasOwn(current, part))
      current = (current as Record<string, unknown>)[part];
    else return undefined;
  }
  return current;
}

function checkCoverEvidenceCaptures(
  root: string,
  sources: readonly DatasetSource[],
  captures: readonly Capture[],
): void {
  const captured = new Map(
    captures.map((capture) => [canonical([capture.url, capture.digest]), capture]),
  );
  for (const image of sources.flatMap((source) => source.images)) {
    const evidence = image.sourceEvidence;
    if (!evidence) continue;
    const capture = captured.get(canonical([evidence.captureUrl, evidence.recordDigest]));
    if (!capture)
      throw new Error(`Cover source capture is absent from the snapshot: ${evidence.captureUrl}`);
    const bytes = verifiedBlob(root, capture.digest);
    if (bytes.length !== capture.bytes)
      throw new Error(`Cover source capture length differs: ${evidence.captureUrl}`);
    let row: unknown;
    try {
      row = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error(`Cover source capture is not JSON: ${evidence.captureUrl}`);
    }
    if (jsonPointerValue(row, evidence.field) !== image.url)
      throw new Error(`Cover field locator does not identify its image URL: ${evidence.field}`);
    if (evidence.holder && jsonPointerValue(row, evidence.holder.field) !== evidence.holder.name)
      throw new Error(
        `Cover holder locator does not identify its holder: ${evidence.holder.field}`,
      );
  }
}

function checkStoredImages(images: readonly StoredImage[]): void {
  for (const image of images) {
    if (image.captureRole !== undefined && image.captureRole !== normalizedCaptureRole(image))
      throw new Error(`Image capture role differs from its source role: ${image.url}`);
    if (image.capture && image.capture.url !== image.url)
      throw new Error(`Image capture URL differs from its source URL: ${image.url}`);
    if (image.missing !== (image.capture === null && image.unavailable === undefined))
      throw new Error('Image availability metadata differs');
  }
}

export async function freezeSnapshot(
  acquisition: Acquisition,
  sources: DatasetSource[],
  images: ImageMode,
): Promise<DatasetSnapshot> {
  checkSources(sources);
  checkCoverEvidenceCaptures(acquisition.root, sources, [...acquisition.captures.values()]);
  const saved: StoredImage[] = [];
  const selected = sources
    .flatMap((source) => source.images)
    .filter(
      (image) =>
        images === 'all' || (images === 'covers' && normalizedCaptureRole(image) === 'cover'),
    );
  for (const image of selected) {
    try {
      const capture = await acquisition.capture(image.url, { limit: 16 * 1024 * 1024 });
      if (!isImage(readFileSync(blobPath(acquisition.root, capture.digest))))
        throw new Error(`Invalid image response: ${image.url}`);
      saved.push({
        ...image,
        captureRole: normalizedCaptureRole(image),
        missing: false,
        capture,
      });
    } catch (error) {
      if (error instanceof MissingRemote)
        saved.push({
          ...image,
          captureRole: normalizedCaptureRole(image),
          capture: null,
          missing: true,
        });
      else if (error instanceof RemoteUnavailable)
        saved.push({
          ...image,
          captureRole: normalizedCaptureRole(image),
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
  checkCoverEvidenceCaptures(acquisition.root, core.sources, core.captures);
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
  checkCoverEvidenceCaptures(root, value.sources, value.captures);
  checkStoredImages(value.images);
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
  checkCoverEvidenceCaptures(root, snapshot.sources, snapshot.captures);
  checkStoredImages(snapshot.images);
  const references = new Map(snapshot.captures.map((capture) => [capture.digest, capture]));
  for (const image of snapshot.images) {
    if (image.capture) references.set(image.capture.digest, image.capture);
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
