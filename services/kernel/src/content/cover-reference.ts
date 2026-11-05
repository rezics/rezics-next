import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import type { PoolClient } from 'pg';
import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import type { ClaimMediaInput } from './media.ts';
import claimCoverMediaStatement from './claim-cover-media.sql';
import type { ImportedSource, Rights } from './imported-contract.ts';
import readCoverReference from './read-cover-reference.sql';

export type CoverReference = Readonly<{
  id: string;
  digest: string;
  containerId: string;
  rights: Rights;
  source: ImportedSource;
  credit?: MediaImportRequest['credit'];
  width?: number;
  height?: number;
  placeholder?: Readonly<{ thumbhash: string; color: string }>;
  variants?: readonly Readonly<{ format: 'avif' | 'webp'; width: number }>[];
  focalPoint?: Readonly<{ x: number; y: number }> | null;
}>;

type CoverSourceReference = Pick<CoverReference, 'id' | 'digest' | 'containerId' | 'rights' | 'source'>;

/** Return field errors for imported cover metadata before a write is attempted. */
export function validateCoverReferenceMetadata(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['metadata'];
  const input = value as Record<string, unknown>;
  const credit = input.credit as Record<string, unknown> | null;
  const provenance = input.provenance;
  const bytes = (item: unknown, maximum: number) => {
    try {
      return new TextEncoder().encode(JSON.stringify(item)).byteLength <= maximum;
    } catch {
      return false;
    }
  };
  const text = (item: unknown, maximum: number) =>
    typeof item === 'string' && item.length > 0 && item.length <= maximum;
  const errors: string[] = [];
  if (!text(input.sourceUrl, 2048)) errors.push('sourceUrl');
  if (
    !credit ||
    typeof credit !== 'object' ||
    !bytes(credit, 8192) ||
    !text(credit.rightsHolder, 1024) ||
    !text((credit.via as Record<string, unknown> | null)?.name, 1024) ||
    !text((credit.via as Record<string, unknown> | null)?.url, 1024) ||
    !text(credit.license, 128)
  )
    errors.push('credit');
  if (!bytes(provenance, 65536)) errors.push('provenance');
  return errors;
}

/** Read an available source-backed reference. This neither claims media nor grants disclosure permission. */
export async function checkMediaObject(
  client: Pick<PoolClient, 'query'>,
  id: string,
  role: 'cover',
): Promise<CoverReference | null> {
  const references = await checkMediaObjects(client, [id], role);
  return references.get(id) ?? null;
}

/** Read up to 256 available source-backed cover references with one statement per media partition. */
export async function checkMediaObjects(
  client: Pick<PoolClient, 'query'>,
  ids: readonly string[],
  role: 'cover',
): Promise<Map<string, CoverReference | null>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length < 1 || uniqueIds.length > 256)
    throw new RangeError('Cover reference batches must contain 1 to 256 ids');

  const results = new Map<string, CoverReference | null>();
  const groups = new Map<number, { routes: number[]; mediaIds: string[] }>();
  for (const id of uniqueIds) {
    results.set(id, null);
    const route = routeOf(id);
    if (role !== 'cover' || route === null) continue;
    const partition = partitionOf(route);
    let group = groups.get(partition);
    if (!group) {
      group = { routes: [], mediaIds: [] };
      groups.set(partition, group);
    }
    group.routes.push(route);
    group.mediaIds.push(id);
  }

  for (const [partition, { routes, mediaIds }] of groups) {
    const rows = await readCoverReference.run(client, { partition, routes, media_ids: mediaIds });
    for (const row of rows) results.set(row.mediaId, coverReferenceWithMetadata(row));
  }
  return results;
}

function coverReference(
  row: Awaited<ReturnType<typeof claimCoverMediaStatement.run>>[number],
): CoverSourceReference | null {
  if (row.sha256 === null) return null;
  const input = {
    containerId: row.containerId,
    sourceUrl: row.sourceUrl,
    credit: row.credit,
    provenance: row.provenance,
  };
  // Persisted import data must meet the same native source/credit contract as a new import.
  // Do not repair malformed rights, infer a licence, or replace the original source references.
  if (validateCoverReferenceMetadata(input).length > 0 || checkMediaImportRequest(input).length > 0) return null;
  const { credit, provenance } = input as MediaImportRequest;
  return {
    id: row.mediaId,
    digest: row.sha256,
    containerId: row.containerId,
    rights: {
      license: credit.license,
      obligations: credit.obligations,
      attribution: `(c) ${credit.rightsHolder}; via [${credit.via.name}](${credit.via.url})`,
    },
    source: provenance,
  };
}

function coverReferenceWithMetadata(
  row: Awaited<ReturnType<typeof readCoverReference.run>>[number],
): CoverReference | null {
  const source = coverReference({
    mediaId: row.mediaId,
    containerId: row.containerId,
    sha256: row.sha256,
    sourceUrl: row.sourceUrl,
    credit: row.credit,
    provenance: row.provenance,
  });
  if (
    source === null ||
    row.width === null ||
    row.width < 1 ||
    row.height === null ||
    row.height < 1 ||
    row.thumbhash === null ||
    row.color === null ||
    !/^#[0-9a-f]{6}$/.test(row.color)
  )
    return null;

  let variants: unknown;
  try {
    variants = JSON.parse(row.variantsJson) as unknown;
  } catch {
    return null;
  }
  if (
    !Array.isArray(variants) ||
    variants.length > 12 ||
    variants.some(
      (variant) =>
        typeof variant !== 'object' ||
        variant === null ||
        !('format' in variant) ||
        (variant.format !== 'avif' && variant.format !== 'webp') ||
        !('width' in variant) ||
        typeof variant.width !== 'number' ||
        !Number.isInteger(variant.width) ||
        variant.width < 1,
    )
  )
    return null;

  const focalPoint = row.focalX === null || row.focalY === null ? null : { x: row.focalX, y: row.focalY };
  return {
    ...source,
    credit: row.credit as MediaImportRequest['credit'],
    width: row.width,
    height: row.height,
    placeholder: { thumbhash: row.thumbhash, color: row.color },
    variants: variants as NonNullable<CoverReference['variants']>,
    focalPoint,
  };
}

/** Internal storage hook for claimMedia's semantic-reference branch. The caller supplies
 * the allocated candidate and numeric revision after current container authorization.
 * A failure must escape the referencing command so all proposal and claim writes roll back.
 */
export async function claimCoverMedia(
  tx: CommandTransaction,
  input: Extract<ClaimMediaInput, { reference: unknown }>,
): Promise<void> {
  const command = currentCommand(tx);
  const { author, reference } = input;
  const route = routeOf(input.containerId);
  const subjectRoute = routeOf(reference.subjectId);
  const candidateRoute = routeOf(reference.candidateId);
  if (
    author.kind !== 'account' ||
    !command.basis ||
    author.accountId !== command.basis.actorAccountId ||
    author.clientId !== command.basis.clientId ||
    author.requestedBy !== command.basis.requestedBy ||
    route === null ||
    partitionOf(route) !== command.partition ||
    reference.kind !== 'semantic_candidate' ||
    reference.subjectId !== input.containerId ||
    subjectRoute === null ||
    candidateRoute === null ||
    partitionOf(subjectRoute) !== command.partition ||
    partitionOf(candidateRoute) !== command.partition ||
    !Number.isSafeInteger(reference.revision) ||
    reference.revision < 1 ||
    reference.revision > 2147483647 ||
    input.mediaIds.length < 1 ||
    input.mediaIds.length > 32 ||
    new Set(input.mediaIds).size !== input.mediaIds.length ||
    input.mediaIds.some((id) => routeOf(id) !== route) ||
    (command.authorization !== null &&
      (command.authorization.mode !== 'execute' ||
        !(
          (command.authorization.resource.id === reference.subjectId &&
            command.authorization.resource.route === subjectRoute) ||
          ((command.authorization.action === 'statement:propose' ||
            command.authorization.action === 'subject:create') &&
            command.authorization.resource.id === GLOBAL_CONTEXT &&
            command.authorization.resource.route === routeOf(GLOBAL_CONTEXT))
        )))
  )
    throw new TypeError('Invalid cover reference command context');
  const rows = await claimCoverMediaStatement.run(tx, {
    route,
    media_ids: [...input.mediaIds],
    container_id: input.containerId,
    uploader_id: author.accountId,
    at: authoritativeTimeValue(command.time),
  });
  if (rows.length !== input.mediaIds.length || rows.some((row) => coverReference(row) === null))
    throw new TypeError('Cover media is unavailable for this reference');
}
