import type { Release } from '@rezics/definitions';
import type { AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { readRelease } from '../semantic/definitions.ts';
import type {
  ProgressInputRules,
  ProgressMeasurePresentation,
  ProgressPresentation,
  ProgressSession,
} from './progress-model.ts';
import {
  compatibleProgressUnits,
  nativeProgressUnit,
  resolveLibraryProfilePin,
  type LibraryProfilePin,
  type LibraryProgressUnitDescriptor,
} from './profile.ts';
import {
  readLibraryProfileAnchor,
  readLibraryProfileSourceObservation,
  sameLibraryProfileAnchor,
  type LibraryProfileSource,
  type LibraryProfileSourceDependencies,
} from './profile-source.ts';

type Fact = { session: ProgressSession; pin: LibraryProfilePin | null };
type Snapshot = { digest: string; release: Release } | null;

/** Same descriptor fields used by native parseRecord/parseSessionCreate, without another parser. */
export function progressInputRules(unit: LibraryProgressUnitDescriptor): ProgressInputRules {
  return {
    ...(unit.minimum === undefined ? {} : { min: unit.minimum }),
    ...(unit.maximum === undefined ? {} : { max: unit.maximum }),
    step: unit.precision === undefined ? 'any' : String(10 ** -unit.precision),
    total: unit.totalPolicy ?? 'optional',
  };
}

/** Exact accepted meaning and independently observed current admission; values never enter this projection. */
export function presentProgressSession(
  fact: Fact,
  snapshot: Snapshot,
  source: LibraryProfileSource,
): ProgressPresentation {
  const base = { structure: 'unverified', recording: { state: 'unavailable' } } as const;
  if (!fact.pin) return { ...base, meaning: 'unknown' };
  const profile = snapshot && resolveLibraryProfilePin(snapshot, fact.pin);
  if (!profile) return { ...base, meaning: 'unavailable' };
  const original = nativeProgressUnit(profile, fact.session);
  const current = source?.kind === 'supported' ? nativeProgressUnit(source.profile, fact.session) : null;
  const recording: ProgressPresentation['recording'] =
    source === null
      ? { state: 'unavailable' }
      : original && current && compatibleProgressUnits(original, current)
        ? { state: 'supported', inputRules: progressInputRules(current) }
        : { state: 'unsupported' };
  if (!original) return { ...base, meaning: 'unknown', recording };
  // English is the native default, from the exact release; no label from a current head or fixed dictionary.
  const forms = original.countForms?.en;
  return {
    meaning: 'known',
    unitLabel: original.labels.en,
    unitLabelLanguage: 'en',
    ...(forms === undefined ? {} : { unitCountForms: { ...forms } }),
    ...(original.dimension === undefined ? {} : { dimension: original.dimension }),
    structure: 'unverified',
    recording,
  };
}

/** One detail, one exact release, one current profile; all owning/foreign snapshots are released between reads. */
export async function prepareProgressPresentation(deps: LibraryProfileSourceDependencies, fact: Fact) {
  const { session, pin } = fact;
  let snapshot: Snapshot = null;
  let source: LibraryProfileSource = null;
  let anchor: Awaited<ReturnType<typeof readLibraryProfileAnchor>> = null;
  let version: Awaited<ReturnType<typeof readLibraryProfileAnchor>> = null;
  if (pin) {
    try {
      const release = await readRelease(deps.pool, pin.releaseDigest, { composed: false });
      if (release) snapshot = { digest: pin.releaseDigest, release };
    } catch {
      // Optional historic display dependency: missing/failed required release never selects a different one.
    }
  }
  try {
    const observed = await readLibraryProfileSourceObservation(deps, session.subjectId);
    source = observed?.source ?? null;
    anchor = observed?.anchor ?? null;
  } catch {
    // Failed or concealed current evidence cannot prove that a capability was retired.
  }
  if (session.versionSubjectId !== null) {
    if (session.versionSubjectId === session.subjectId) version = anchor;
    else {
      try {
        version = await readLibraryProfileAnchor(deps, session.versionSubjectId);
      } catch {
        // Version summaries have their own current disclosure, independent of historical display.
      }
    }
  }
  return {
    presentation: presentProgressSession(fact, snapshot, source),
    measurePresentations: (session.measures ?? []).map((measure): ProgressMeasurePresentation => ({
      unit: measure.unit,
      presentation: presentProgressSession(
        { ...fact, session: { ...session, unit: measure.unit, amount: measure.amount, total: measure.total } },
        snapshot,
        source,
      ),
    })),
    disclosure: { subject: source !== null, versionSubject: version !== null },
    async verify(at: AuthoritativeTime) {
      const current = { ...deps, at };
      if (anchor && !sameLibraryProfileAnchor(anchor, await readLibraryProfileAnchor(current, session.subjectId)))
        throw new ProblemError('semantic_not_ready');
      if (
        version &&
        session.versionSubjectId !== session.subjectId &&
        !sameLibraryProfileAnchor(version, await readLibraryProfileAnchor(current, session.versionSubjectId!))
      )
        throw new ProblemError('semantic_not_ready');
    },
  };
}
