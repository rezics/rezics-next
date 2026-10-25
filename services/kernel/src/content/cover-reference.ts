import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
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
  const row = rows[0];
  if (!row || rows.length !== 1 || row.sha256 === null) return null;
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
