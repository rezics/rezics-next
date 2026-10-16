import { createHash } from 'node:crypto';
import { OPEN_LIBRARY_WORKS_RUN, SourceRunUnavailable } from './acquisition-run.ts';
import type { SourceRunEvidence } from './run-evidence.ts';
import type { ExternalReleaseEvidence } from './external-release.ts';

/** Edition identities are provider evidence, without inferred authorship or native credit. */
export function openLibraryExternalReleases(snapshot: SourceRunEvidence): ExternalReleaseEvidence[] | null {
  if (snapshot.provider !== 'open-library' || snapshot.acquisitionProfile !== OPEN_LIBRARY_WORKS_RUN) return null;
  const editions = snapshot.surfaces.find(surface => surface.surface === 'editions');
  if (!editions || editions.outcome?.outcome !== 'qualified') {
    throw new SourceRunUnavailable('Open Library edition evidence is incomplete');
  }
  const releases: ExternalReleaseEvidence[] = [];
  for (const capture of snapshot.captures.filter(item => item.surface === 'editions')) {
    let body: { size?: unknown; entries?: unknown };
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(capture.bytes)); }
    catch { throw new SourceRunUnavailable('Open Library edition evidence is malformed'); }
    if (!body || !Number.isSafeInteger(body.size) || Number(body.size) < 0
      || !Array.isArray(body.entries) || body.entries.length > 25) {
      throw new SourceRunUnavailable('Open Library edition evidence is unbounded');
    }
    for (const entry of body.entries) {
      const key: unknown = entry?.key;
      if (typeof key !== 'string' || !/^\/books\/OL[1-9][0-9]{0,11}M$/.test(key)) {
        throw new SourceRunUnavailable('Open Library edition identity is unavailable');
      }
      const release = `open-library:edition:${key.slice('/books/'.length)}`;
      releases.push({ release, sourceClaim: `urn:rezics:source-occurrence:${createHash('sha256')
        .update(`${capture.digest}\0${release}`).digest('hex')}`,
      observation: capture.observation, captureDigest: capture.digest });
    }
  }
  return releases;
}

