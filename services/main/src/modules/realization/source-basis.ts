import { readRealizationReceipt, type RealizationCommandReceipt } from './command.ts';
import {
  parseStoredRealization,
  realizationDigest,
  REALIZATION_COST,
  REALIZATION_PROFILE,
  type RealizationRecord,
} from './schema.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import {
  releaseNativeAdmission,
  releaseNativeFailure,
  validReleaseNativeCommand,
  type ReleaseNativeCommandBasis,
  type ReleaseSourceVerificationFailure,
} from '../source/release-native-verifier.ts';

export interface RealizationSourceBasisRead {
  status: 'available';
  record: RealizationRecord;
  receipt: RealizationCommandReceipt;
  head: string;
}

/** Read an exact immutable text and its actual command; never follow its head
 * to replace the revision which a release covers. Disclosure is checked by the
 * correspondence verifier before these private owner facts can be returned. */
export async function readRealizationSourceBasis(
  env: WorkActivationEnvironment,
  basis: ReleaseNativeCommandBasis,
): Promise<RealizationSourceBasisRead | ReleaseSourceVerificationFailure> {
  if (!validReleaseNativeCommand(basis)) {
    return releaseNativeFailure('target-mismatch', 'realization-command-basis-invalid');
  }
  const admission = await releaseNativeAdmission(env, basis.receipt);
  const receipt = admission ? await readRealizationReceipt(env, admission) : null;
  if (!receipt || receipt.outcome !== 'succeeded') {
    return releaseNativeFailure('unavailable', 'realization-command-receipt-unavailable');
  }
  if (
    receipt.receipt !== basis.receipt ||
    receipt.realization !== basis.component ||
    receipt.revision !== basis.revision ||
    !receipt.work
  ) {
    return releaseNativeFailure('target-mismatch', 'realization-command-basis-differs');
  }
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT ?work ?head ?state WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(basis.component)} a rv:Realization ; rv:work ?work ; rv:head ?head . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(basis.revision)} a rv:RealizationRevision ;
        rv:component ${iri(basis.component)} ; rv:modelRevision ${iri(REALIZATION_PROFILE)} ; rv:realizationState ?state .
        FILTER NOT EXISTS { ${iri(basis.revision)} a rv:ErasedRevision } }
    } LIMIT 2`,
        REALIZATION_COST.stateBytes * 2,
      )
    ).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.work || !row.head || !row.state) {
    return releaseNativeFailure('unavailable', 'realization-owner-evidence-unavailable');
  }
  if (row.work.value !== receipt.work)
    return releaseNativeFailure('target-mismatch', 'realization-work-differs');
  const record = parseStoredRealization(row.state.value, row.work.value);
  if (
    record.id !== basis.component ||
    receipt.scope !== `work:edit:${record.work}` ||
    realizationDigest(record) !== receipt.requestDigest
  ) {
    return releaseNativeFailure('target-mismatch', 'realization-command-state-differs');
  }
  if (row.head.value !== basis.expectedHead)
    return releaseNativeFailure('head-mismatch', 'realization-head-moved');
  return { status: 'available', record, receipt, head: row.head.value };
}
