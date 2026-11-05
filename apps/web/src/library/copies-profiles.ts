import type { Release } from '../subject/definitions';
import type { LibraryProfile } from '@rezics/definitions';
import { libraryProfile, libraryCopyKindLabel, libraryCopyStatusLabel } from './profiles';
import { m } from '../paraglide/messages.js';
import type { LibrarySubject } from './reads';

type ReleasedCopyKind = NonNullable<LibraryProfile['copies']>['kinds'][number];
export type CopyProfile = {
  kinds: (Pick<ReleasedCopyKind, 'condition'> & {
    id: string;
    label: string;
    labelLanguage?: string;
    statuses: { id: string; label: string; labelLanguage?: string }[];
  })[];
};

export type CopySubjectResult =
  | { state: 'ready'; subject: LibrarySubject; profile: CopyProfile }
  | { state: 'unsupported' | 'forbidden' | 'unavailable' | 'closed' };

/** Serialize only the choices and localized labels needed by this subject, never the definitions release. */
export function resolveCopyProfile(release: Release, type: string, locale: string): CopyProfile {
  return {
    kinds: (libraryProfile(release, type)?.copies?.kinds ?? []).map((kind) => {
      const label = libraryCopyKindLabel(release, type, kind.id, locale);
      return {
        id: kind.id,
        // Preserve explicit admission only; a physical label or ID supplies no capability.
        ...(kind.condition === undefined ? {} : { condition: kind.condition }),
        label: label?.text ?? m.library_other(),
        ...(label ? { labelLanguage: label.lang } : {}),
        statuses: kind.statuses.map(({ id }) => {
          const label = libraryCopyStatusLabel(release, type, kind.id, id, locale);
          return { id, label: label?.text ?? m.library_other(), ...(label ? { labelLanguage: label.lang } : {}) };
        }),
      };
    }),
  };
}

export function copyLabels(release: Release, type: string, kind: string | null, status: string, locale: string) {
  return {
    kindLabel: kind
      ? (libraryCopyKindLabel(release, type, kind, locale)?.text ?? m.library_other())
      : m.library_other(),
    statusLabel:
      libraryCopyStatusLabel(release, type, kind ?? 'legacy-unspecified', status, locale)?.text ?? m.library_other(),
  };
}

export type CopyProfileState =
  | { state: 'ready'; profile: CopyProfile }
  | { state: 'unsupported' }
  | { state: 'unavailable' };

/** Copy choices come from the current released profile; an empty or missing descriptor is unsupported. */
export function copyProfileState(release: Release | undefined, type: string, locale: string): CopyProfileState {
  if (!release) return { state: 'unavailable' };
  const profile = resolveCopyProfile(release, type, locale);
  return profile.kinds.some((kind) => kind.statuses.length) ? { state: 'ready', profile } : { state: 'unsupported' };
}
