import { createHash } from 'node:crypto';
import type { SourceRunEvidence } from '../source/run-evidence.ts';
import { canonicalExport, type ExportLoss, type ExportPlan, type VerifiedExportMember } from './planner.ts';

/** Exact source bytes and custody metadata; provider interpretation stays in adapters. */
export function sourceRunExport(snapshot: SourceRunEvidence, actingSubject: string,
  useScope: ExportPlan['useScope']) {
  const members: VerifiedExportMember[] = snapshot.captures.map(capture => ({
    sourceOwner: 'source', sourceNamespace: snapshot.provider, sourceGrain: 'source_observation',
    exactRef: capture.observation, contentRevisionId: null, refDigest: capture.digest,
    ownerDataEpoch: snapshot.position.dataEpoch, ownerSequence: snapshot.position.sequence,
    sourcePosition: `${snapshot.run}#${capture.requestKey}`, targetGrain: 'SourceObservation', mapping: 'exact',
    data: { provider: snapshot.provider, run: snapshot.run, acquisitionProfile: snapshot.acquisitionProfile,
      exportActor: actingSubject, surface: capture.surface, ordinal: capture.ordinal, role: capture.role,
      observation: capture.observation, record: capture.record, namespace: capture.namespace,
      externalId: capture.externalId, sourceRevision: capture.sourceRevision, requestKey: capture.requestKey,
      url: capture.url, fetchedAt: capture.fetchedAt, byteDigest: capture.digest, byteLength: capture.bytes.length,
      rawBytesBase64: capture.bytes.toString('base64') },
  }));
  const data = { provider: snapshot.provider, run: snapshot.run, acquisitionProfile: snapshot.acquisitionProfile,
    exportActor: actingSubject, surfaces: snapshot.surfaces.map(surface => ({ surface: surface.surface,
      required: surface.required, retention: surface.retention,
      outcome: surface.outcome?.outcome, reason: surface.outcome?.reason,
      captureCount: surface.captures.length, captureSetDigest: surface.outcome?.captureSetDigest })),
    nativeDisposition: 'source-evidence-only' };
  members.push({ sourceOwner: 'source', sourceNamespace: snapshot.provider, sourceGrain: 'claim',
    exactRef: `${snapshot.run}#capture-manifest`, contentRevisionId: null,
    refDigest: createHash('sha256').update(canonicalExport(data)).digest('hex'),
    ownerDataEpoch: snapshot.position.dataEpoch, ownerSequence: snapshot.position.sequence,
    sourcePosition: snapshot.run, targetGrain: 'SourceAcquisitionRun', mapping: 'exact', data });
  const residuals: ExportLoss[] = snapshot.surfaces.filter(surface => surface.outcome?.outcome !== 'qualified')
    .map(surface => ({ memberOrdinal: members.length, kind: 'missing_member', path: '/surfaces',
      detail: { surface: surface.surface, reason: surface.outcome?.reason ?? 'unavailable' } }));
  return { targetProfile: 'rezics-source-run-v1', useScope, members, residuals };
}
