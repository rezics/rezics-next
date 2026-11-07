import { memoizedValue } from '../memoized.ts';
import { CoverCreditSchema, type MediaImportRequest } from '@rezics/definitions/media-import';
import { Compile } from 'typebox/compile';
import { GrantDeniedError } from '../access/contract/index.ts';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { authorizeMediaDerivative, type DownloadContext } from './media-download.ts';
import { mediaParentSnapshot } from './media-parent.ts';
import type { MediaDependencies } from './media.ts';
import read from './media-presentation.sql';

export type DocumentImagePresentation = Readonly<{
  id: string;
  containerId: string;
  digest: string;
  width: number;
  height: number;
  variants: readonly { format: 'avif' | 'webp'; width: number; height: number }[];
  placeholder: { thumbhash: string; color: string } | null;
  focalPoint: { x: number; y: number } | null;
  credit: MediaImportRequest['credit'] | null;
}>;
export type DocumentMediaPage = Readonly<{ images: readonly DocumentImagePresentation[] }>;

type Row = NonNullable<Awaited<ReturnType<typeof authorizeMediaDerivative>>>;
function credit() {
  return memoizedValue(credit, () => Compile(CoverCreditSchema));
}
const digest = /^[0-9a-f]{64}$/;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function presentation(row: Row): DocumentImagePresentation | null {
  if (
    row.state !== 'available' ||
    row.erased ||
    row.collection_pending ||
    row.taken_down ||
    !row.sha256 ||
    !digest.test(row.sha256) ||
    !positive(row.width) ||
    !positive(row.height) ||
    (row.variant_format !== 'avif' && row.variant_format !== 'webp') ||
    !positive(row.variant_width) ||
    !positive(row.variant_height) ||
    row.variant_media_type !== `image/${row.variant_format}` ||
    (row.credit !== null && !credit().Check(row.credit))
  )
    return null;
  return {
    id: row.media_id,
    containerId: row.container_id,
    digest: row.sha256,
    width: row.width,
    height: row.height,
    variants: [{ format: row.variant_format, width: row.variant_width, height: row.variant_height }],
    placeholder:
      row.thumbhash && row.average_color && /^#[0-9a-f]{6}$/.test(row.average_color)
        ? { thumbhash: row.thumbhash, color: row.average_color }
        : null,
    focalPoint: row.focal_x !== null && row.focal_y !== null ? { x: row.focal_x, y: row.focal_y } : null,
    credit: row.credit,
  };
}

/** Exact media keys only. Each image advertises one actual largest WebP (or
 * AVIF) derivative, verified by the same source/final authority as its bytes.
 * Enumeration and authorization release every checkout before foreign anchors.
 */
export async function readDocumentMediaPresentations(
  deps: MediaDependencies,
  actor: Actor,
  ids: readonly string[],
  context: DownloadContext,
): Promise<DocumentMediaPage> {
  if (
    ids.length < 1 ||
    ids.length > 32 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => id.length !== 36 || routeOf(id) === null)
  )
    throw new RangeError('Expected one to thirty-two unique routed media IDs');
  const selected: { row: Row; variant: Parameters<typeof authorizeMediaDerivative>[3] }[] = [];
  if (!Number.isFinite(context.deadline) || Date.now() >= context.deadline) return { images: [] };
  for (const id of ids) {
    let rows: Row[];
    try {
      rows = await mediaParentSnapshot(deps.pool, routeOf(id)!, context.deadline, (client) =>
        read.run(client, { route: routeOf(id)!, media_id: id }),
      );
    } catch (error) {
      if (error instanceof GrantDeniedError) continue;
      throw error;
    }
    // This is selection from facts, never a permission decision. Do not retry or
    // refill when the selected derivative or any native security anchor changes.
    const before = rows.find((row) => presentation(row) !== null);
    if (!before) continue;
    const variant = `${before.variant_format as 'avif' | 'webp'}-${before.variant_width!}` as const;
    const current = await authorizeMediaDerivative(deps, id, actor, variant, context, before);
    if (current) selected.push({ row: current, variant });
  }
  // An early successful member is not permission for the completed collection.
  // Repeat current parent/Realm/media disclosure after selection has finished,
  // pinned to the exact selected row and slot. O(ids * H) point work, no refill,
  // history enumeration, persisted permission or unrelated media scan.
  const images: DocumentImagePresentation[] = [];
  for (const { row, variant } of selected) {
    const current = await authorizeMediaDerivative(deps, row.media_id, actor, variant, context, row);
    const image = current && presentation(current);
    if (image) images.push(image);
  }
  return Date.now() >= context.deadline ? { images: [] } : { images };
}
