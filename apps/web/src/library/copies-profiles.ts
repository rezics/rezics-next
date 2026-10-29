import type { Release } from '../subject/definitions';
import { libraryChoices, libraryCopyKindLabel, libraryCopyStatusLabel } from './profiles';
import { m } from '../paraglide/messages.js';

export type CopyProfile = { kinds: { id: string; label: string; statuses: { id: string; label: string }[] }[] };

/** Serialize only the choices and localized labels needed by this subject, never the definitions release. */
export function resolveCopyProfile(release: Release, type: string, locale: string): CopyProfile {
  return {
    kinds: (libraryChoices(release, type)?.copyKinds ?? []).map((kind) => ({
      id: kind.id,
      label: libraryCopyKindLabel(release, type, kind.id, locale)?.text ?? m.library_other(),
      statuses: kind.statuses.map((id) => ({
        id,
        label: libraryCopyStatusLabel(release, type, kind.id, id, locale)?.text ?? m.library_other(),
      })),
    })),
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
