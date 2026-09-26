import { createHash } from 'node:crypto';
import { planExport, type ExportLoss, type ExportPlan, type LicenseScopeHook, type VerifiedExportMember } from './planner.ts';
import type { VndbConceptRunSnapshot } from '../source/vndb-concept-run.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const unknownRights: LicenseScopeHook = async (members, useScope) => [{ basisKind: 'unprotected_fact',
  basisRef: null, licenseExpression: null, notice: null, obligations: [], useScope,
  result: 'undetermined', memberOrdinals: members.map((_, index) => index + 1) }];

/**
 * Preserve one verified frozen VNDB capture set as source data. Four bounded response
 * bodies are carried byte-for-byte beside the structured projection. Native candidates
 * stay candidates: the residual records that no Context, speaker or acceptance decision
 * was supplied by acquisition. Work is linear in at most 256 KiB of source bytes plus the
 * projected occurrences, and the shared export planner enforces its 1 MiB output bound.
 */
export async function planVndbSourceExport(snapshot: VndbConceptRunSnapshot,
  actingSubject: string, useScope: ExportPlan['useScope'], rights: LicenseScopeHook = unknownRights):
  Promise<ExportPlan> {
  const members: VerifiedExportMember[] = snapshot.captures.map((capture, index) => {
    const data = { provider: snapshot.provider, run: snapshot.run, surface: capture.surface,
      observation: capture.observation, requestKey: capture.requestKey, url: capture.url,
      fetchedAt: capture.fetchedAt, byteDigest: capture.digest, byteLength: capture.bytes.length,
      rawBytesBase64: capture.bytes.toString('base64') };
    return { sourceOwner: 'source', sourceNamespace: 'vndb-fixture', sourceGrain: 'source_observation',
      exactRef: capture.observation, contentRevisionId: null, refDigest: capture.digest,
      ownerDataEpoch: snapshot.position.dataEpoch, ownerSequence: String(index + 1),
      sourcePosition: `${snapshot.run}/${capture.surface}`, targetGrain: 'SourceObservation',
      mapping: 'exact', data };
  });
  // The export canonicalizer admits safe integers, not IEEE floating point. Preserve
  // provider scores as decimal lexical values; their original JSON number lexemes remain
  // in the byte-for-byte capture members above.
  const projection = { ...snapshot.projection,
    claims: snapshot.projection.claims.map(claim => ({ ...claim,
      score: claim.score === null ? null : { kind: 'decimal' as const, lexical: String(claim.score) } })),
    nativeClaims: snapshot.projection.nativeClaims.map(claim => ({ ...claim,
      score: claim.score === null ? null : { kind: 'decimal' as const, lexical: String(claim.score) } })) };
  const projectionData = { run: snapshot.run, exportActor: actingSubject,
    projection,
    exportDisposition: { status: 'exact-source-capture', nativeDisposition: 'candidate-only',
      residual: 'Native Statement export needs a separately accepted Context, speaker and decision.' } };
  const projectionOrdinal = members.length + 1;
  members.push({ sourceOwner: 'source', sourceNamespace: 'vndb-fixture', sourceGrain: 'claim',
    exactRef: `${snapshot.run}#projection`, contentRevisionId: null, refDigest: sha(JSON.stringify(projectionData)),
    ownerDataEpoch: snapshot.position.dataEpoch, ownerSequence: '0', sourcePosition: snapshot.run,
    targetGrain: 'VndbConceptProjection', mapping: 'exact', data: projectionData });

  const residuals: ExportLoss[] = snapshot.projection.nativeClaims.length ? [{
    memberOrdinal: projectionOrdinal, kind: 'qualified_claim', path: '/projection/nativeClaims',
    detail: { count: snapshot.projection.nativeClaims.length,
      reason: 'Candidate source occurrences have no native Context, speaker or separate acceptance receipt.' },
  }] : [];
  return planExport({ targetProfile: 'rezics-vndb-concept-source-v1', useScope, members, residuals }, rights);
}
