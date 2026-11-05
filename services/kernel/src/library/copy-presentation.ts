import type { Release } from '@rezics/definitions';
import type { AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { readRelease } from '../semantic/definitions.ts';
import { chooseLabel } from '../semantic/language.ts';
import {
  COPY_CONDITION_CHOICES,
  copyConditionAdmission,
  presentCopyCondition,
  type CopyConditionDisplay,
} from './copy-condition.ts';
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

function conditionPresentation(
  fact: CopyPresentationFact,
  source: LibraryProfileSource,
  snapshots: ReadonlyMap<string, Snapshot>,
) {
  function acceptedKind(field: 'mediaCondition' | 'packagingCondition') {
    const observation = fact.copy.conditionFacts?.[field];
    if (!observation) return null;
    const snapshot = snapshots.get(observation.pin.releaseDigest);
    const profile = snapshot && resolveLibraryProfilePin(snapshot, observation.pin);
    return profile?.copies?.kinds.find((candidate) => candidate.id === observation.kindId) ?? null;
  }

  const display = (field: 'mediaCondition' | 'packagingCondition'): CopyConditionDisplay =>
    presentCopyCondition(fact.copy.conditionFacts?.[field], acceptedKind(field));
  const sameSource = source !== null && source.subjectId === fact.copy.subjectId;
  let conditionEditing: CopyPresentation['conditionEditing'];
  if (!sameSource || !source) {
    conditionEditing = {
      state: 'unavailable',
      currentness: 'unavailable',
      reason: 'current_source_unavailable',
    };
  } else if (source.kind !== 'supported') {
    conditionEditing = { state: 'unavailable', currentness: 'retired', reason: 'retired' };
  } else {
    const currentKind = fact.copy.kind
      ? source.profile.copies?.kinds.find((candidate) => candidate.id === fact.copy.kind)
      : undefined;
    if (!currentKind) {
      conditionEditing = { state: 'unavailable', currentness: 'retired', reason: 'retired' };
    } else {
      const admission = copyConditionAdmission(currentKind);
      conditionEditing =
        admission.state === 'supported'
          ? { state: 'supported', currentness: 'current', choices: COPY_CONDITION_CHOICES }
          : { state: 'unavailable', currentness: 'current', reason: admission.reason };
    }
  }
  return {
    mediaCondition: display('mediaCondition'),
    packagingCondition: display('packagingCondition'),
    conditionEditing,
  };
}

/** Accepted vocabulary and current native status choices are independent observations. */
export function presentCopy(
  fact: CopyPresentationFact,
  snapshot: Snapshot,
  source: LibraryProfileSource,
  languages: readonly string[] = [],
  statusSnapshot: Snapshot = snapshot,
  conditionSnapshots: ReadonlyMap<string, Snapshot> = new Map(),
): CopyPresentation {
  const unavailable = { state: 'unavailable' } as const;
  const conditions = conditionPresentation(fact, source, conditionSnapshots);
  const kindProfile = fact.kindPin && snapshot && resolveLibraryProfilePin(snapshot, fact.kindPin);
  const statusProfile = fact.statusPin && statusSnapshot && resolveLibraryProfilePin(statusSnapshot, fact.statusPin);
  // Missing provenance is unknown. A required exact release that cannot resolve is unavailable.
  if ((fact.kindPin && !kindProfile) || (fact.statusPin && !statusProfile))
    return { meaning: 'unavailable', statusEditing: unavailable, ...conditions };
  if (!kindProfile || !statusProfile) return { meaning: 'unknown', statusEditing: unavailable, ...conditions };
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
  // The native writer requires the current source to retain this exact subject identity.
  const sameSource = source !== null && source.subjectId === fact.copy.subjectId;
  let statusEditing: CopyPresentation['statusEditing'] = sameSource ? { state: 'unsupported' } : unavailable;
  if (original && acceptedStatus && current && sameSource && source?.kind === 'supported') {
    const statuses = current.statuses.flatMap((candidate) => {
      if (!hasCopyStatus(source.profile, current.id, candidate.id)) return [];
      const label = chooseLabel(candidate.labels, languages);
      return label ? [{ id: candidate.id, label: label.value, labelLanguage: label.language }] : [];
    });
    // No fabricated empty capability if required presentation data cannot be read.
    statusEditing =
      statuses.length && statuses.length === current.statuses.length ? { state: 'supported', statuses } : unavailable;
  }
  if (!original || !acceptedStatus) return { meaning: 'unknown', statusEditing, ...conditions };
  const kindLabel = chooseLabel(original.labels, languages);
  const statusLabel = chooseLabel(acceptedStatus.labels, languages);
  return {
    meaning: 'known',
    ...(kindLabel ? { kindLabel: kindLabel.value, kindLabelLanguage: kindLabel.language } : {}),
    ...(statusLabel ? { statusLabel: statusLabel.value, statusLabelLanguage: statusLabel.language } : {}),
    statusEditing,
    ...conditions,
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
  // Resolve only the exact immutable releases that accepted these observations, never a history walk.
  const pins = [
    fact.kindPin,
    fact.statusPin,
    fact.copy.conditionFacts?.mediaCondition?.pin ?? null,
    fact.copy.conditionFacts?.packagingCondition?.pin ?? null,
  ];
  for (const pin of pins) {
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
      snapshots,
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
