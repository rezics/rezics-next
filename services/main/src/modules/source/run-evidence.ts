import { createHash } from 'node:crypto';
import { SourceRunInvalid, SourceRunUnavailable, type RunCaptureView, type RunSurfaceView,
  type SourceRunStore } from './acquisition-run.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export interface SourceRunEvidenceCapture extends RunCaptureView {
  surface: string;
  digest: string;
  bytes: Buffer;
}

export interface SourceRunEvidence {
  run: string;
  provider: string;
  acquisitionProfile: string;
  position: { dataEpoch: string; sequence: string };
  surfaces: RunSurfaceView[];
  captures: SourceRunEvidenceCapture[];
}

/** Private, completed run custody. No provider call, parsing or native adoption.
 * Bounds apply before reading bytes; the export planner separately bounds output.
 * The position encoding preserves existing single-capture surface manifests. */
export async function readSourceRunEvidence(runs: Pick<SourceRunStore, 'read' | 'frozen'>,
  principalId: string, runId: string): Promise<SourceRunEvidence> {
  if (!UUID.test(principalId) || !UUID.test(runId)) throw new SourceRunInvalid('invalid source run identity');
  const run = await runs.read(principalId, runId);
  if (!run || run.state !== 'completed' || run.run !== `https://rezics.com/id/${runId}`
    || !run.surfaces.length || run.surfaces.length > 32) {
    throw new SourceRunUnavailable('completed source run is unavailable');
  }
  const listed = run.surfaces.flatMap(surface => surface.captures);
  if (!listed.length || listed.length > 128
    || new Set(listed.map(capture => capture.requestKey)).size !== listed.length
    || listed.some(capture => capture.retention !== 'retained' || !capture.byteDigest
      || capture.byteLength === null || capture.byteLength < 0)
    || listed.reduce((sum, capture) => sum + (capture.byteLength ?? 0), 0) > 262_144
    || run.surfaces.some(surface => !surface.outcome
      || surface.required && surface.outcome.outcome !== 'qualified'
      || surface.outcome.captureCount !== surface.captures.length)) {
    throw new SourceRunUnavailable('source run evidence is unavailable or exceeds the capture budget');
  }
  const captures: SourceRunEvidenceCapture[] = [];
  for (const surface of run.surfaces) {
    for (const capture of surface.captures) {
      const frozen = await runs.frozen(runId, capture.requestKey);
      if (!frozen || frozen.status !== 200 || !frozen.bytes
        || frozen.ordinal !== capture.ordinal || frozen.requestKey !== capture.requestKey
        || frozen.bytes.length !== capture.byteLength || sha(frozen.bytes) !== capture.byteDigest) {
        throw new SourceRunUnavailable('frozen source capture differs from run evidence');
      }
      captures.push({ ...capture, surface: surface.surface, digest: capture.byteDigest!, bytes: frozen.bytes });
    }
  }
  return { run: run.run, provider: run.provider, acquisitionProfile: run.acquisitionProfile,
    surfaces: run.surfaces, captures, position: { dataEpoch: sha(captures.map(capture =>
      `${capture.surface}\t${capture.digest}`).join('\n')), sequence: '0' } };
}
