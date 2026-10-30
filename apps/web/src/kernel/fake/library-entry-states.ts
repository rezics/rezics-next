import definitions from '../recorded/definitions-release.json';
import type { FakeRoute } from '../fake-modules.ts';

export const routes: FakeRoute[] = [];

type RecordedState = { id: string; role?: string };
type RecordedRelease = {
  types?: Record<string, { library?: { profileId?: string } }>;
  libraryProfiles?: Record<string, { entryStateSet?: { states?: RecordedState[] } }>;
};

const release = definitions.release as unknown as RecordedRelease;

/** Use the bundled Book profile's declared order and identifiers in fake responses too. */
export function recordedBookState(index: number): string | undefined;
export function recordedBookState(role: string): string | undefined;
export function recordedBookState(indexOrRole: number | string): string | undefined {
  const profileId = release.types?.['schema:Book']?.library?.profileId;
  const states = profileId ? release.libraryProfiles?.[profileId]?.entryStateSet?.states : undefined;
  const state =
    typeof indexOrRole === 'number' ? states?.[indexOrRole] : states?.find((item) => item.role === indexOrRole);
  return state?.id;
}
