import { SourceRunUnavailable, type SourceRunStore } from './acquisition-run.ts';
import { readSourceRunEvidence, type SourceRunEvidence } from './run-evidence.ts';
import { openLibraryExternalReleases } from './open-library-release.ts';
import { vndbExternalReleases } from './vndb-concept-run.ts';

export interface ExternalReleaseReference {
  run: string;
  release: string;
  sourceClaim: string;
  expectedPosition: { dataEpoch: string; sequence: string };
}

export interface ExternalReleaseEvidence {
  release: string;
  sourceClaim: string;
  observation: string;
  captureDigest: string;
}

/** Shared manifests preserve opaque absolute references; adapters own their grammar. */
export function isExternalEvidenceReference(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512
    && /^[a-z][a-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/.test(value);
}

export interface ExternalReleaseRunEvidence extends SourceRunEvidence {
  releases: ExternalReleaseEvidence[];
}

/** Source interprets provider evidence once; Work and export consume exact references. */
export async function readExternalReleaseRunEvidence(runs: Pick<SourceRunStore, 'read' | 'frozen'>,
  principalId: string, runId: string): Promise<ExternalReleaseRunEvidence> {
  const snapshot = await readSourceRunEvidence(runs, principalId, runId);
  const releases = openLibraryExternalReleases(snapshot) ?? vndbExternalReleases(snapshot);
  if (!releases) throw new SourceRunUnavailable('source run has no admitted external release mapping');
  return { ...snapshot, releases };
}

export function verifyExternalReleaseReference(snapshot: ExternalReleaseRunEvidence,
  reference: ExternalReleaseReference): ExternalReleaseEvidence {
  const matches = snapshot.releases.filter(item => item.release === reference.release
    && item.sourceClaim === reference.sourceClaim);
  if (snapshot.run !== reference.run
    || snapshot.position.dataEpoch !== reference.expectedPosition.dataEpoch
    || snapshot.position.sequence !== reference.expectedPosition.sequence || matches.length !== 1) {
    throw new SourceRunUnavailable('external release does not match frozen source position');
  }
  return matches[0]!;
}
