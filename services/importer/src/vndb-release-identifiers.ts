import {
  converter_revision as entityRevision,
  decodeVndbReleaseGtin,
  retainVndbReleaseGtin,
  vndbReleaseGtinUnknown,
} from '@rezics/conversion/cross-media-entities';
import {
  importVndbReleaseFidelity,
  planVndbReleaseFidelity,
  type VndbReleaseFidelityResult,
} from './vndb-release-fidelity.ts';
import type { CrossMediaPlan, CrossMediaPort, CrossMediaTables } from './cross-media-seed.ts';
import type { SourceVocabularyBindings } from '@rezics/conversion';

export { decodeVndbReleaseGtin, retainVndbReleaseGtin, vndbReleaseGtinUnknown, entityRevision };

/** Selected-family and date-fidelity COPY rows already carry `releases.gtin`; conversion admits it once. */
export async function planVndbReleaseIdentifiers(
  input: CrossMediaTables,
): Promise<CrossMediaPlan & { facts: Awaited<ReturnType<typeof planVndbReleaseFidelity>>['facts'] }> {
  return planVndbReleaseFidelity(input);
}

/** Production operator: propose an admitted source barcode through the existing seed/importer caller. */
export async function importVndbReleaseIdentifiers(input: {
  tables: CrossMediaTables;
  path: string;
  port: CrossMediaPort;
  bindings: SourceVocabularyBindings;
  destination?: { origin: string };
}): Promise<VndbReleaseFidelityResult> {
  return importVndbReleaseFidelity(input);
}
