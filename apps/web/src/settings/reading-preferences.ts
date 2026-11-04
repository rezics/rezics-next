import type {
  NativePreferenceFailure,
  PreferenceChange,
  PreferenceWriteResult,
  ReadingAdvice,
  ReadingPreferences,
  SettingsPage,
} from './preferences';

export type ReadingValues = Pick<ReadingPreferences, 'spoilerLevel' | 'suitability'>;
export type ReadingIO = {
  save: (input: Readonly<PreferenceChange>) => Promise<PreferenceWriteResult>;
  read: () => Promise<SettingsPage>;
};
export type ReadingReadback =
  | { ok: true; preferences: ReadingPreferences }
  | { ok: false; reason: 'closed' | 'preparing' | 'unavailable' | 'forbidden'; failure?: NativePreferenceFailure };

export function sameReading(a: ReadingValues, b: ReadingValues): boolean {
  return a.spoilerLevel === b.spoilerLevel && a.suitability === b.suitability;
}

/** Capture just the changed reading fields; a notification version is never a reading baseline. */
export function readingMutation(known: ReadingPreferences, draft: ReadingValues): Readonly<PreferenceChange> | null {
  if (sameReading(known, draft)) return null;
  return Object.freeze({
    expectedVersion: known.version,
    ...(known.spoilerLevel !== draft.spoilerLevel ? { spoilerLevel: draft.spoilerLevel } : {}),
    ...(known.suitability !== draft.suitability ? { suitability: draft.suitability } : {}),
    idempotencyKey: crypto.randomUUID(),
  });
}

/** Native defaults with the reviewed version; never a browser-invented default. */
export function readingReset(known: ReadingPreferences): Readonly<PreferenceChange> | null {
  const defaults = readingDefaults(known.advice);
  if (!defaults || !ownerMayChangeReading(known.advice) || !validReading(known, known.version)) return null;
  if (sameReading(known, defaults)) return null;
  return Object.freeze({
    expectedVersion: known.version,
    spoilerLevel: defaults.spoilerLevel,
    suitability: defaults.suitability,
    idempotencyKey: crypto.randomUUID(),
  });
}

export function ownerMayChangeReading(advice: ReadingPreferences['advice']): boolean {
  return advice?.viewerState === 'current' && advice.allowedActions?.update?.allowed === true;
}

export function readingAdviceFor(values: ReadingValues, writable = true): NonNullable<ReadingPreferences['advice']> {
  return {
    viewerState: 'current',
    allowedActions: {
      read: { allowed: true },
      update: writable ? { allowed: true } : { allowed: false, reason: 'not_authorized' },
    },
    reading: {
      supported: { spoilerLevels: [0, 1, 2], suitability: ['blur', 'show'] },
      effective: { spoilerLevel: values.spoilerLevel, suitability: values.suitability },
      defaults: { spoilerLevel: 0, suitability: 'blur' },
    },
  };
}

export function readingChangeAdmitted(
  change: Readonly<PreferenceChange>,
  supported: ReadingAdvice['reading']['supported'],
): boolean {
  return (
    (change.spoilerLevel === undefined || supported.spoilerLevels.includes(change.spoilerLevel)) &&
    (change.suitability === undefined || supported.suitability.includes(change.suitability))
  );
}

function isSpoilerLevel(value: unknown): value is ReadingValues['spoilerLevel'] {
  return value === 0 || value === 1 || value === 2;
}

function isSuitability(value: unknown): value is ReadingValues['suitability'] {
  return value === 'blur' || value === 'show';
}

export function readingAdviceReady(advice: ReadingPreferences['advice']): boolean {
  if (!advice || advice.viewerState !== 'current' || advice.allowedActions?.read?.allowed !== true) return false;
  const reading = advice.reading;
  const levels = reading?.supported?.spoilerLevels;
  const suitability = reading?.supported?.suitability;
  const effective = reading?.effective;
  const defaults = reading?.defaults;
  return (
    Array.isArray(levels) &&
    levels.length > 0 &&
    levels.every(isSpoilerLevel) &&
    Array.isArray(suitability) &&
    suitability.length > 0 &&
    suitability.every(isSuitability) &&
    !!effective &&
    isSpoilerLevel(effective.spoilerLevel) &&
    isSuitability(effective.suitability) &&
    levels.includes(effective.spoilerLevel) &&
    suitability.includes(effective.suitability) &&
    !!defaults &&
    isSpoilerLevel(defaults.spoilerLevel) &&
    isSuitability(defaults.suitability) &&
    levels.includes(defaults.spoilerLevel) &&
    suitability.includes(defaults.suitability)
  );
}

export function readingDefaults(advice: ReadingPreferences['advice']): ReadingValues | undefined {
  if (!advice || !readingAdviceReady(advice)) return undefined;
  return { spoilerLevel: advice.reading.defaults.spoilerLevel, suitability: advice.reading.defaults.suitability };
}

function supportedReading(preferences: ReadingPreferences): boolean {
  const advice = preferences.advice;
  if (!advice || !readingAdviceReady(advice)) return false;
  return (
    advice.reading.effective.spoilerLevel === preferences.spoilerLevel &&
    advice.reading.effective.suitability === preferences.suitability
  );
}

function validReading(preferences: ReadingPreferences, minimumVersion: number): boolean {
  return (
    Number.isSafeInteger(preferences.version) &&
    preferences.version >= Math.max(0, minimumVersion) &&
    supportedReading(preferences)
  );
}

export async function readReading(
  io: Pick<ReadingIO, 'read'>,
  minimumVersion: number | (() => number),
): Promise<ReadingReadback> {
  try {
    const page = await io.read();
    if (!page.signedIn) return { ok: false, reason: 'forbidden' };
    if (!('preferences' in page)) {
      const { failure } = page;
      const reason =
        failure.code === 'platform_closed' || page.state === 'closed'
          ? 'closed'
          : failure.status === 401 || failure.status === 403
            ? 'forbidden'
            : 'unavailable';
      return { ok: false, reason, failure };
    }
    const { preferences } = page;
    if (preferences.advice?.allowedActions?.read?.allowed === false) return { ok: false, reason: 'forbidden' };
    // Another preference card can confirm a newer version while this GET is in flight.
    if (!validReading(preferences, typeof minimumVersion === 'function' ? minimumVersion() : minimumVersion))
      return { ok: false, reason: 'unavailable' };
    return { ok: true, preferences };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export type ReadingAttemptResult =
  | { kind: 'confirmed'; preferences: ReadingPreferences; receipt: ReadingPreferences }
  | { kind: 'confirmed-read-failed'; receipt: ReadingPreferences; reason: string; failure?: NativePreferenceFailure }
  | { kind: 'uncertain'; reason: string; failure?: NativePreferenceFailure; operation?: 'read' }
  | { kind: 'rejected'; reason: string; failure?: NativePreferenceFailure };

/** Retry the immutable original input. A replay receipt is historical, so recovery also requires a current GET. */
export async function sendReading(
  io: ReadingIO,
  input: Readonly<PreferenceChange>,
  recovering: boolean,
  currentVersion: () => number,
): Promise<ReadingAttemptResult> {
  let result: PreferenceWriteResult;
  try {
    result = await io.save(input);
  } catch {
    return { kind: 'uncertain', reason: 'unavailable' };
  }
  if (!result.ok) {
    return {
      kind:
        result.reason === 'unavailable' || result.reason === 'preparing' || (recovering && result.reason !== 'conflict')
          ? 'uncertain'
          : 'rejected',
      reason: result.reason,
      ...(result.failure ? { failure: result.failure } : {}),
    };
  }
  const receipt = result.preferences;
  if (
    !validReading(receipt, input.expectedVersion) ||
    (input.spoilerLevel !== undefined && receipt.spoilerLevel !== input.spoilerLevel) ||
    (input.suitability !== undefined && receipt.suitability !== input.suitability)
  )
    return { kind: 'uncertain', reason: 'unavailable' };
  if (!recovering && currentVersion() <= receipt.version) return { kind: 'confirmed', preferences: receipt, receipt };
  const current = await readReading(io, () => Math.max(receipt.version, currentVersion()));
  if (!current.ok)
    return {
      kind: 'confirmed-read-failed',
      receipt,
      reason: current.reason,
      ...(current.failure ? { failure: current.failure } : {}),
    };
  if (current.preferences.version === receipt.version && !sameReading(current.preferences, receipt))
    return { kind: 'confirmed-read-failed', receipt, reason: 'unavailable' };
  return { kind: 'confirmed', preferences: current.preferences, receipt };
}
