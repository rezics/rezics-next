import type { Release } from '@rezics/definitions';
import type { PartRow, PartStream, WorkPartsRead } from '../../features/catalogue/work-parts';
import {
  CANONICAL_EPISODE_TYPE,
  CANONICAL_ID,
  MEMBERSHIP_PAGE_CAP,
  type ChecklistRow,
} from './contract';

type Definitions = Pick<Release, 'types' | 'properties'>;

export type MembershipCandidate = {
  id: string;
  label: string | null;
  ordinal: string | null;
  type: string;
};

export type MembershipPage =
  | { state: 'unavailable'; reason: 'missing-descriptor' | 'read-failed' | 'not-episode' }
  | { state: 'admitted'; candidates: MembershipCandidate[]; next: string | null; stream: string };

function isType(release: Definitions, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

export function isCanonicalEpisodeType(release: Definitions, type: string | undefined): boolean {
  return !!type && isType(release, type, CANONICAL_EPISODE_TYPE);
}

function positionOf(row: PartRow): string | null {
  const qualifier = row.statement?.qualifiers.find((part) => part.property.id === 'schema:position');
  return qualifier?.value.type === 'value' && typeof qualifier.value.content === 'string'
    ? qualifier.value.content
    : null;
}

function labelOf(row: PartRow): string | null {
  const label = row.summary?.label;
  return label && typeof label.value === 'string' ? label.value : null;
}

function episodeIdFromRow(row: PartRow, stream: PartStream, release: Definitions): MembershipCandidate | undefined {
  if (stream.direction === 'inverse' && stream.property === 'schema:isPartOf') {
    const type = row.summary?.type;
    if (!type || !CANONICAL_ID.test(row.holder) || !isCanonicalEpisodeType(release, type)) return undefined;
    return { id: row.holder, label: labelOf(row), ordinal: positionOf(row), type };
  }
  if (stream.direction === 'forward') {
    const summaryType = row.summary?.type;
    if (row.summary?.id && summaryType && CANONICAL_ID.test(row.summary.id) && isCanonicalEpisodeType(release, summaryType)) {
      return { id: row.summary.id, label: labelOf(row), ordinal: positionOf(row), type: summaryType };
    }
    for (const [id, related] of Object.entries(row.related ?? {})) {
      if (related.type && CANONICAL_ID.test(id) && isCanonicalEpisodeType(release, related.type)) {
        return { id, label: labelOf(row), ordinal: positionOf(row), type: related.type };
      }
    }
  }
  return undefined;
}

function streamAdmitsEpisodes(stream: PartStream, rows: readonly PartRow[], release: Definitions): boolean {
  if (stream.property === 'schema:isPartOf' && stream.direction === 'inverse') {
    return rows.length === 0 || rows.some((row) => isCanonicalEpisodeType(release, row.summary?.type));
  }
  return rows.some((row) => episodeIdFromRow(row, stream, release) !== undefined);
}

/** Prefer inverse schema:isPartOf; otherwise the work-parts default stream. Do not scan remaining streams. */
export function selectedMembershipStream(read: Extract<WorkPartsRead, { ok: true }>): PartStream | undefined {
  return read.streams.find((stream) => stream.property === 'schema:isPartOf' && stream.direction === 'inverse') ?? read.stream;
}

export function projectMembership(read: WorkPartsRead, release: Definitions): MembershipPage {
  if (!read.ok) return { state: 'unavailable', reason: 'read-failed' };
  const stream = selectedMembershipStream(read);
  if (!stream) return { state: 'unavailable', reason: 'missing-descriptor' };
  if (!streamAdmitsEpisodes(stream, read.rows, release)) return { state: 'unavailable', reason: 'not-episode' };
  const seen = new Set<string>();
  const candidates: MembershipCandidate[] = [];
  for (const row of read.rows) {
    const candidate = episodeIdFromRow(row, stream, release);
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    candidates.push(candidate);
    if (candidates.length >= MEMBERSHIP_PAGE_CAP) break;
  }
  return { state: 'admitted', candidates, next: read.next, stream: stream.key };
}

export function membershipLabels(candidates: readonly MembershipCandidate[]): Map<string, MembershipCandidate> {
  return new Map(candidates.map((candidate) => [candidate.id, candidate]));
}

export function labelledRows(
  rows: readonly ChecklistRow[],
  candidates: readonly MembershipCandidate[],
): ChecklistRow[] {
  const labels = membershipLabels(candidates);
  return rows.map((row) => {
    if (!row.episodeSubjectId) return row;
    const candidate = labels.get(row.episodeSubjectId);
    if (!candidate) return row;
    return { ...row, label: candidate.label, ordinal: row.ordinal ?? candidate.ordinal };
  });
}
