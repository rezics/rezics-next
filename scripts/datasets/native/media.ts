import { isImage, normalizedCaptureRole, snapshotMediaImages } from '../snapshot.ts';
import type { Capture } from '../network.ts';
import { canonical, sha256, verifiedBlob } from '../store.ts';
import type {
  DatasetCaptureRole,
  DatasetImage,
  DatasetMappingContext,
  DatasetMediaEvidence,
  DatasetNativeMapper,
  DatasetSnapshot,
  StoredImage,
} from '../types.ts';

export interface DatasetMediaCandidate {
  /** Stable occurrence key, not a new native resource or media Use identity. */
  key: string;
  path: string;
  record: string;
  target: string | null;
  /** Only an API-returned Content variant; a MainVersion is not a Content variant. */
  variant: string | null;
  role: DatasetCaptureRole;
  sourceRole: string;
  image: DatasetImage;
  capture: Capture | null;
  acquisition: 'captured' | 'not-captured' | 'missing' | 'unavailable';
  sourceEvidence: DatasetMediaEvidence | null;
  /** Metadata database licences and a named holder grant no image licence. */
  rights: {
    basis: 'unknown';
    license: null;
    holder: string | null;
    source: { name: string; href: string } | null;
  };
  status: 'captured' | 'pending' | 'source-only';
  reason:
    | 'native-use-required'
    | 'missing-evidence'
    | 'acquisition-failed'
    | 'invalid-capture'
    | 'target-unavailable'
    | 'unsupported-role'
    | 'unelected-cover';
}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const variantId = /^urn:rezics:variant:[0-9a-f-]{36}$/;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function coverRank(image: DatasetImage): number {
  if (image.role === 'selected-cover') return 0;
  if (image.role === 'candidate-cover') return Infinity;
  return normalizedCaptureRole(image) === 'cover' ? 1 : Infinity;
}

/** Capture-all retains alternatives, but never makes a vote or screenshot an adopted cover. */
export function electedDatasetCovers<T extends DatasetImage>(images: readonly T[]): T[] {
  const elected = new Map<string, T>();
  for (const image of [...images].sort((left, right) =>
    canonical(left).localeCompare(canonical(right)),
  )) {
    if (!Number.isFinite(coverRank(image))) continue;
    const prior = elected.get(image.record);
    if (!prior || coverRank(image) < coverRank(prior)) elected.set(image.record, image);
  }
  return [...elected.values()];
}

/** Facts for the existing media owner. A captured candidate is never an accepted Use. */
export function datasetMediaCandidates(
  root: string,
  context: Pick<DatasetMappingContext, 'snapshot' | 'native'>,
): DatasetMediaCandidate[] {
  const frozen = snapshotMediaImages(root, context.snapshot);
  const sameImage = (left: DatasetImage, right: DatasetImage) =>
    left.record === right.record && left.role === right.role && left.url === right.url;
  const images: Array<{ image: DatasetImage; stored?: StoredImage; path: string }> = frozen.map(
    (image, index) => ({ image, stored: image, path: `/images/${index}` }),
  );
  context.snapshot.sources.forEach((source, sourceIndex) =>
    source.images.forEach((image, imageIndex) => {
      if (!frozen.some((stored) => sameImage(stored, image)))
        images.push({ image, path: `/sources/${sourceIndex}/images/${imageIndex}` });
    }),
  );
  const covers = electedDatasetCovers(context.snapshot.sources.flatMap((source) => source.images));
  return images.map(({ image, stored, path }) => {
    const mapped = context.native.get(image.record);
    const record = context.snapshot.sources
      .flatMap((source) => source.records)
      .find((item) => item.key === image.record);
    const evidence = image.sourceEvidence ?? null;
    const rawVariant = mapped?.receipt.variantId;
    const candidate: DatasetMediaCandidate = {
      key: sha256(
        canonical([image.record, image.role, image.url, evidence, stored?.capture?.digest ?? null]),
      ),
      path,
      record: image.record,
      target: mapped && nativeId.test(mapped.id) ? mapped.id : null,
      variant: typeof rawVariant === 'string' && variantId.test(rawVariant) ? rawVariant : null,
      role: normalizedCaptureRole(image),
      sourceRole: image.role,
      image,
      sourceEvidence: evidence,
      capture: stored?.capture ?? null,
      acquisition: !stored
        ? 'not-captured'
        : stored.missing
          ? 'missing'
          : stored.unavailable
            ? 'unavailable'
            : 'captured',
      rights: {
        basis: 'unknown',
        license: null,
        holder: evidence?.holder?.name ?? null,
        source: evidence ? { name: evidence.sourceName, href: evidence.sourceUrl } : null,
      },
      status: 'captured',
      reason: 'native-use-required',
    };
    const pending = (reason: DatasetMediaCandidate['reason']) =>
      Object.assign(candidate, { status: 'pending' as const, reason });
    if (
      !candidate.target ||
      !record ||
      record.native === 'source-only' ||
      (candidate.role === 'cover' && (record.native !== 'work' || mapped?.kind !== 'work')) ||
      (candidate.role === 'portrait' &&
        (record.native !== 'character' || mapped?.kind !== 'character'))
    )
      return pending('target-unavailable');
    if (candidate.role === 'other')
      return { ...candidate, status: 'source-only', reason: 'unsupported-role' };
    if (candidate.role === 'cover' && !covers.some((cover) => sameImage(cover, image)))
      return { ...candidate, status: 'source-only', reason: 'unelected-cover' };
    if (!evidence) return pending('missing-evidence');
    if (!stored?.capture || stored.missing || stored.unavailable)
      return pending('acquisition-failed');
    try {
      const bytes = verifiedBlob(root, stored.capture.digest);
      if (
        stored.capture.url !== image.url ||
        bytes.length !== stored.capture.bytes ||
        !imageTypes.has(stored.capture.mediaType) ||
        !isImage(bytes)
      )
        return pending('invalid-capture');
    } catch {
      return pending('invalid-capture');
    }
    return candidate;
  });
}

/** Explicitly elected Work covers; callers must retain the evidence before an admitted upload. */
export function datasetWorkCoverImages(root: string, snapshot: DatasetSnapshot): StoredImage[] {
  const works = new Set(
    snapshot.sources
      .flatMap((source) => source.records)
      .filter((record) => record.native === 'work')
      .map((record) => record.key),
  );
  const elected = electedDatasetCovers(snapshot.sources.flatMap((source) => source.images));
  return snapshotMediaImages(root, snapshot).filter(
    (image) =>
      works.has(image.record) &&
      elected.some(
        (cover) =>
          cover.record === image.record && cover.role === image.role && cover.url === image.url,
      ),
  );
}

/** The current API cannot attach source portraits or publish imported-cover assets.
 * The importer owns Work cover receipts and must consume datasetWorkCoverImages;
 * this mapper must never downgrade one of its acknowledged cover mappings.
 * Source candidates without a frozen image have no image occurrence in the shared
 * coverage inventory yet. They remain visible in datasetMediaCandidates, rather
 * than inventing a coverage key or declaring their acquisition absent. */
export function datasetMediaMapper(root: string): DatasetNativeMapper {
  return {
    id: 'media',
    revision: 'captured-media-v1',
    async map(context) {
      for (const candidate of datasetMediaCandidates(root, context)) {
        if (!context.selected.has(candidate.record)) continue;
        if (candidate.role === 'cover' || !candidate.path.startsWith('/images/')) continue;
        const reason =
          candidate.status !== 'captured'
            ? candidate.reason
            : candidate.role === 'portrait'
              ? 'api-contract-unavailable: importedCover requires a Work; no source portrait admission/receipt'
              : 'api-contract-unavailable: imported images cannot enter media-set-v1 with source/rights custody';
        context.disposition(
          { record: candidate.record, kind: 'image', path: candidate.path },
          {
            status: candidate.status === 'source-only' ? 'source-only' : 'unmapped',
            reason,
          },
        );
      }
    },
  };
}
