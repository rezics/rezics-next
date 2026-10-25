import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import type { PoolClient } from 'pg';
import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
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
}>;

/** Read an available source-backed reference. This neither claims media nor grants disclosure permission. */
export async function checkMediaObject(
  client: Pick<PoolClient, 'query'>,
  id: string,
  role: 'cover',
): Promise<CoverReference | null> {
  const route = routeOf(id);
  if (route === null || role !== 'cover') return null;
  const rows = await readCoverReference.run(client, { route, media_id: id });
  return rows.length === 1 ? coverReference(rows[0]!) : null;
}

function coverReference(row: Awaited<ReturnType<typeof claimCoverMediaStatement.run>>[number]): CoverReference | null {
  if (row.sha256 === null) return null;
  const input = {
    containerId: row.containerId,
    sourceUrl: row.sourceUrl,
    credit: row.credit,
    provenance: row.provenance,
  };
  // Persisted import data must meet the same native source/credit contract as a new import.
  // Do not repair malformed rights, infer a licence, or replace the original source references.
  if (checkMediaImportRequest(input).length > 0) return null;
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
        command.authorization.resource.id !== reference.subjectId ||
        command.authorization.resource.route !== subjectRoute))
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
