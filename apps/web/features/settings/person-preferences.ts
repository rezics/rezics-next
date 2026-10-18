export type PersonPreferences = {
  profile: 'person-preferences-v1';
  profileVisibility: 'public' | 'private';
  followPolicy: 'everyone' | 'nobody';
  hideReadingActivity: boolean;
  contentLanguages: string[];
  spoilerPolicy: 'hide-unread' | 'show';
  version: number;
  blockedPeople: string[];
};

export type PersonPreferencePatch = Partial<Pick<PersonPreferences,
  'profileVisibility' | 'followPolicy' | 'hideReadingActivity' | 'spoilerPolicy'>>;

export function sameLanguages(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/** Take a command snapshot; a receipt can only acknowledge these choices. */
export function personPreferenceCommand(current: PersonPreferences, languages: readonly string[],
  patch: PersonPreferencePatch) {
  const { profile: _profile, version, blockedPeople: _blocked, ...prior } = current;
  return { ...prior, ...patch, contentLanguages: [...languages], expectedVersion: version };
}

/** A conflict refresh updates untouched choices without discarding a local language draft. */
export function languagesAfterRefresh(current: PersonPreferences, languages: readonly string[],
  latest: PersonPreferences): string[] {
  return [...(sameLanguages(current.contentLanguages, languages) ? latest.contentLanguages : languages)];
}
