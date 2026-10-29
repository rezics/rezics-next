import { bundledRelease } from '@rezics/definitions/bundled';
import { libraryChoices } from './profiles';

/** Compatibility for callers with a bundled accepting type; pages use their server-resolved choices. */
export function progressDefaultUnit(types: readonly string[] | undefined): string {
  for (const type of types ?? []) {
    const unit = libraryChoices(bundledRelease, type)?.progress[0]?.units[0]?.id;
    if (unit) return unit;
  }
  return '';
}
