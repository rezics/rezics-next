import type { Release } from '@rezics/definitions';
import type { AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { readRelease } from '../semantic/definitions.ts';
import { chooseLabel } from '../semantic/language.ts';
import type { CopyPresentation } from './copy-model.ts';
import type { Copy } from './entry-model.ts';
import { hasCopyStatus, resolveLibraryProfilePin, type LibraryProfilePin } from './profile.ts';
import {
  readLibraryProfileAnchor,
  readLibraryProfileSourceObservation,
  sameLibraryProfileAnchor,
  type LibraryProfileSource,
  type LibraryProfileSourceDependencies,
} from './profile-source.ts';

export type CopyPresentationFact = {
  copy: Copy;
  kindPin: LibraryProfilePin | null;
  statusPin: LibraryProfilePin | null;
};
type Snapshot = { digest: string; release: Release } | null;

/** Accepted vocabulary and current native status choices are independent observations. */
export function presentCopy(
  fact: CopyPresentationFact,
  snapshot: Snapshot,
  source: LibraryProfileSource,
  languages: readonly string[] = [],
  statusSnapshot: Snapshot = snapshot,
): CopyPresentation {
  const unavailable = { state: 'unavailable' } as const;
  const kindProfile = fact.kindPin && snapshot && resolveLibraryProfilePin(snapshot, fact.kindPin);
  const statusProfile = fact.statusPin && statusSnapshot && resolveLibraryProfilePin(statusSnapshot, fact.statusPin);
  // Missing provenance is unknown. A required exact release that cannot resolve is unavailable.
  if ((fact.kindPin && !kindProfile) || (fact.statusPin && !statusProfile))
    return { meaning: 'unavailable', statusEditing: unavailable };
  if (!kindProfile || !statusProfile) return { meaning: 'unknown', statusEditing: unavailable };
  const { kind, status } = fact.copy;
  // Raw historical IDs, including migrated unspecified holdings, are never inferred from a Type.
  const original =
    kind && kind !== 'legacy-unspecified'
      ? kindProfile.copies?.kinds.find((candidate) => candidate.id === kind)
      : undefined;
  const acceptedStatus = statusProfile.copies?.kinds
    .find((candidate) => candidate.id === kind)
    ?.statuses.find((candidate) => candidate.id === status);
  const current =
    source?.kind === 'supported' && kind
      ? source.profile.copies?.kinds.find((candidate) => candidate.id === kind)
      : undefined;
  let statusEditing: CopyPresentation['statusEditing'] = source === null ? unavailable : { state: 'unsupported' };
  if (original && acceptedStatus && current && source?.kind === 'supported') {
    const statuses = current.statuses.flatMap((candidate) => {
      if (!hasCopyStatus(source.profile, current.id, candidate.id)) return [];
      const label = chooseLabel(candidate.labels, languages);
      return label ? [{ id: candidate.id, label: label.value, labelLanguage: label.language }] : [];
    });
    // No fabricated empty capability if required presentation data cannot be read.
    statusEditing =
      statuses.length && statuses.length === current.statuses.length ? { state: 'supported', statuses } : unavailable;
  }
  if (!original || !acceptedStatus) return { meaning: 'unknown', statusEditing };
  const kindLabel = chooseLabel(original.labels, languages);
  const statusLabel = chooseLabel(acceptedStatus.labels, languages);
  return {
    meaning: 'known',
    ...(kindLabel ? { kindLabel: kindLabel.value, kindLabelLanguage: kindLabel.language } : {}),
    ...(statusLabel ? { statusLabel: statusLabel.value, statusLabelLanguage: statusLabel.language } : {}),
    statusEditing,
  };
}

/** One detail only. Each owner/foreign home is released before the next observation. */
export async function prepareCopyPresentation(
  deps: LibraryProfileSourceDependencies,
  fact: CopyPresentationFact,
  languages: readonly string[],
) {
  const snapshots = new Map<string, Snapshot>();
  let source: LibraryProfileSource = null;
  let anchor: Awaited<ReturnType<typeof readLibraryProfileAnchor>> = null;
  // At most two exact immutable lookups, deduplicated for fresh copies; never a history walk.
  for (const pin of [fact.kindPin, fact.statusPin]) {
    if (!pin || snapshots.has(pin.releaseDigest)) continue;
    let snapshot: Snapshot = null;
    try {
      const release = await readRelease(deps.pool, pin.releaseDigest, { composed: false });
      if (release) snapshot = { digest: pin.releaseDigest, release };
    } catch {
      // Optional display dependency failure cannot select another release.
    }
    snapshots.set(pin.releaseDigest, snapshot);
  }
  try {
    const observed = await readLibraryProfileSourceObservation(deps, fact.copy.subjectId);
    source = observed?.source ?? null;
    anchor = observed?.anchor ?? null;
  } catch {
    // Concealed or failed current evidence cannot prove retirement.
    try {
      anchor = await readLibraryProfileAnchor(deps, fact.copy.subjectId);
    } catch {
      // Current summaries remain independently unavailable on source failure.
    }
  }
  return {
    presentation: presentCopy(
      fact,
      fact.kindPin ? (snapshots.get(fact.kindPin.releaseDigest) ?? null) : null,
      source,
      languages,
      fact.statusPin ? (snapshots.get(fact.statusPin.releaseDigest) ?? null) : null,
    ),
    disclosure: { subject: anchor !== null },
    async verify(at: AuthoritativeTime) {
      if (
        anchor &&
        !sameLibraryProfileAnchor(anchor, await readLibraryProfileAnchor({ ...deps, at }, fact.copy.subjectId))
      )
        throw new ProblemError('semantic_not_ready');
    },
  };
}
