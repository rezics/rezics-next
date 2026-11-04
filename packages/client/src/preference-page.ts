/** Strict decoder for the additive account preference-page envelope. */

export const PREFERENCE_READING_DEFAULTS = Object.freeze({ spoilerLevel: 0, suitability: 'blur' } as const);
export type PreferenceSpoilerLevel = 0 | 1 | 2;
export type PreferenceSuitability = 'blur' | 'show';
export type PreferenceActionAdvice =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'not_authorized' };
export type PreferencePageAdvice = {
  viewerState: 'current';
  allowedActions: { read: PreferenceActionAdvice; update: PreferenceActionAdvice };
  reading: {
    supported: { spoilerLevels: PreferenceSpoilerLevel[]; suitability: PreferenceSuitability[] };
    effective: { spoilerLevel: PreferenceSpoilerLevel; suitability: PreferenceSuitability };
    defaults: { spoilerLevel: 0; suitability: 'blur' };
  };
};
export type PreferencePageValues = {
  spoilerLevel: PreferenceSpoilerLevel;
  suitability: PreferenceSuitability;
  version: number;
  shelf?: unknown;
  notifications?: unknown;
};
export type PreferenceReadingPage = PreferencePageValues & PreferencePageAdvice;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function spoilerLevel(value: unknown): PreferenceSpoilerLevel | undefined {
  return value === 0 || value === 1 || value === 2 ? value : undefined;
}

function suitability(value: unknown): PreferenceSuitability | undefined {
  return value === 'blur' || value === 'show' ? value : undefined;
}

function uniqueMembers<T>(values: T[], allowed: (value: unknown) => value is T): T[] | undefined {
  if (new Set(values).size !== values.length) return undefined;
  const members: T[] = [];
  for (const value of values) {
    if (!allowed(value)) return undefined;
    members.push(value);
  }
  return members;
}

function actionAdvice(value: unknown): PreferenceActionAdvice | undefined {
  if (!isRecord(value) || value.allowed === true) {
    return isRecord(value) && value.allowed === true && Object.keys(value).length === 1 ? { allowed: true } : undefined;
  }
  return value.allowed === false && value.reason === 'not_authorized' && Object.keys(value).length === 2
    ? { allowed: false, reason: 'not_authorized' }
    : undefined;
}

/** Confirmed stored values, or `undefined` when spoiler, suitability or version cannot be read. */
export function decodePreferenceValues(value: unknown): PreferencePageValues | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 0) return undefined;
  const spoiler = spoilerLevel(value.spoilerLevel);
  const image = suitability(value.suitability);
  if (spoiler === undefined || image === undefined) return undefined;
  return {
    spoilerLevel: spoiler,
    suitability: image,
    version: value.version as number,
    ...(value.shelf !== undefined ? { shelf: value.shelf } : {}),
    ...(value.notifications !== undefined ? { notifications: value.notifications } : {}),
  };
}

/** Owner reading advice, or `undefined` when any choice or action field is missing or malformed. */
export function decodePreferenceAdvice(value: unknown): PreferencePageAdvice | undefined {
  if (!isRecord(value) || value.viewerState !== 'current' || !isRecord(value.allowedActions) || !isRecord(value.reading))
    return undefined;
  const read = actionAdvice(value.allowedActions.read);
  const update = actionAdvice(value.allowedActions.update);
  if (!read || !update || Object.keys(value.allowedActions).some((key) => key !== 'read' && key !== 'update'))
    return undefined;
  const { supported, effective, defaults } = value.reading;
  if (
    !isRecord(supported) ||
    !isRecord(effective) ||
    !isRecord(defaults) ||
    Object.keys(value.reading).some((key) => key !== 'supported' && key !== 'effective' && key !== 'defaults')
  )
    return undefined;
  if (
    !Array.isArray(supported.spoilerLevels) ||
    !Array.isArray(supported.suitability) ||
    Object.keys(supported).some((key) => key !== 'spoilerLevels' && key !== 'suitability')
  )
    return undefined;
  const spoilerLevels = uniqueMembers(supported.spoilerLevels, (entry): entry is PreferenceSpoilerLevel =>
    [0, 1, 2].includes(entry as number),
  );
  const suitabilityChoices = uniqueMembers(supported.suitability, (entry): entry is PreferenceSuitability =>
    entry === 'blur' || entry === 'show',
  );
  if (
    !spoilerLevels ||
    !suitabilityChoices ||
    spoilerLevels.length < 1 ||
    spoilerLevels.length > 3 ||
    suitabilityChoices.length < 1 ||
    suitabilityChoices.length > 2
  )
    return undefined;
  const effectiveSpoiler = spoilerLevel(effective.spoilerLevel);
  const effectiveSuitability = suitability(effective.suitability);
  if (
    effectiveSpoiler === undefined ||
    effectiveSuitability === undefined ||
    !spoilerLevels.includes(effectiveSpoiler) ||
    !suitabilityChoices.includes(effectiveSuitability) ||
    Object.keys(effective).some((key) => key !== 'spoilerLevel' && key !== 'suitability')
  )
    return undefined;
  if (
    defaults.spoilerLevel !== 0 ||
    defaults.suitability !== 'blur' ||
    Object.keys(defaults).some((key) => key !== 'spoilerLevel' && key !== 'suitability')
  )
    return undefined;
  return {
    viewerState: 'current',
    allowedActions: { read, update },
    reading: {
      supported: { spoilerLevels, suitability: suitabilityChoices },
      effective: { spoilerLevel: effectiveSpoiler, suitability: effectiveSuitability },
      defaults: { spoilerLevel: 0, suitability: 'blur' },
    },
  };
}

/** Complete native page, or `undefined` when values and advice disagree or either part is unreadable. */
export function decodePreferencePage(value: unknown): PreferenceReadingPage | undefined {
  const values = decodePreferenceValues(value);
  const advice = decodePreferenceAdvice(value);
  if (!values || !advice) return undefined;
  if (
    advice.reading.effective.spoilerLevel !== values.spoilerLevel ||
    advice.reading.effective.suitability !== values.suitability
  )
    return undefined;
  return { ...values, ...advice };
}
