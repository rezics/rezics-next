import type { LibraryCopyKindDescriptor, LibraryProfilePin } from './profile.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';

/** Library vocabulary, independent of catalogue labels, sellers and valuations. */
export const COPY_CONDITION_VOCABULARY = 'physical-v1';
export const COPY_CONDITION_CHOICES = Object.freeze([
  Object.freeze({ id: 'unknown', label: 'Unknown', description: 'Assessed without a known grade.' }),
  Object.freeze({ id: 'mint', label: 'Mint', description: 'No observable wear or defects.' }),
  Object.freeze({ id: 'near_mint', label: 'Near mint', description: 'Almost no observable wear.' }),
  Object.freeze({ id: 'very_good_plus', label: 'Very good plus', description: 'Minor observable wear.' }),
  Object.freeze({ id: 'very_good', label: 'Very good', description: 'Noticeable wear, still fully usable.' }),
  Object.freeze({ id: 'good', label: 'Good', description: 'Substantial wear, still usable.' }),
  Object.freeze({ id: 'fair', label: 'Fair', description: 'Damage limits ordinary use.' }),
  Object.freeze({ id: 'poor', label: 'Poor', description: 'Severe damage prevents ordinary use.' }),
] as const);

export type CopyConditionValue = (typeof COPY_CONDITION_CHOICES)[number]['id'];
export type CopyConditionField = 'mediaCondition' | 'packagingCondition';
export type CopyConditionPatch = Readonly<{
  mediaCondition?: CopyConditionValue | null;
  packagingCondition?: CopyConditionValue | null;
}>;

/** An absent observation predates assessment; null is an intentional clear. */
export type CopyConditionObservation = Readonly<{
  value: CopyConditionValue | null;
  pin: LibraryProfilePin;
  kindId: string;
}>;
export type CopyConditionFacts = Readonly<{
  mediaCondition?: CopyConditionObservation;
  packagingCondition?: CopyConditionObservation;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeObservation(value: unknown): CopyConditionObservation | undefined {
  if (value === null || value === undefined) return undefined;
  if (!record(value) || Object.keys(value).length !== 3) throw new Error('Invalid stored copy condition observation');
  const pin = decodeLibraryProfilePin(value.pin);
  if (
    !Object.hasOwn(value, 'value') ||
    !pin ||
    typeof value.kindId !== 'string' ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(value.kindId) ||
    (value.value !== null && !isCopyConditionValue(value.value))
  )
    throw new Error('Invalid stored copy condition observation');
  return { value: value.value, pin, kindId: value.kindId };
}

/** Decode only the private row representation; absent observations remain absent. */
export function decodeCopyConditionFacts(
  mediaCondition: unknown,
  packagingCondition: unknown,
): CopyConditionFacts | undefined {
  const media = decodeObservation(mediaCondition);
  const packaging = decodeObservation(packagingCondition);
  if (!media && !packaging) return undefined;
  return {
    ...(media === undefined ? {} : { mediaCondition: media }),
    ...(packaging === undefined ? {} : { packagingCondition: packaging }),
  };
}

export class CopyConditionInvalidError extends Error {
  constructor(readonly field: CopyConditionField) {
    super(`Invalid copy field: ${field}`);
    this.name = 'CopyConditionInvalidError';
  }
}

export function isCopyConditionValue(value: unknown): value is CopyConditionValue {
  return COPY_CONDITION_CHOICES.some((choice) => choice.id === value);
}

/** Merge this result into the existing complete command input before hashing it.
 * Missing fields stay missing, so old receipts retain their original operands.
 */
export function parseCopyConditionFields(input: Readonly<Record<string, unknown>>): CopyConditionPatch {
  const patch: { mediaCondition?: CopyConditionValue | null; packagingCondition?: CopyConditionValue | null } = {};
  for (const field of ['mediaCondition', 'packagingCondition'] as const) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (value !== null && !isCopyConditionValue(value)) throw new CopyConditionInvalidError(field);
    patch[field] = value;
  }
  return patch;
}

export type CopyConditionAdmission = Readonly<
  | { state: 'supported'; vocabulary: typeof COPY_CONDITION_VOCABULARY; choices: typeof COPY_CONDITION_CHOICES }
  | { state: 'unavailable'; reason: 'unsupported' | 'unrecognized_vocabulary' }
>;

/** Only an explicit released kind capability admits condition. Never infer physicality from an ID or label.
 * The retained Definitions publisher must add `condition?: 'physical-v1'` to its closed kind contract.
 * Until then existing published kinds remain unavailable, including kinds named "physical".
 */
export function copyConditionAdmission(kind: LibraryCopyKindDescriptor | null): CopyConditionAdmission {
  if (!kind || !('condition' in kind)) return { state: 'unavailable', reason: 'unsupported' };
  if (kind.condition !== COPY_CONDITION_VOCABULARY) return { state: 'unavailable', reason: 'unrecognized_vocabulary' };
  return { state: 'supported', vocabulary: COPY_CONDITION_VOCABULARY, choices: COPY_CONDITION_CHOICES };
}

export type CopyConditionAcceptance = Readonly<{
  kind: LibraryCopyKindDescriptor;
  pin: LibraryProfilePin;
}>;

/** Pure field merge for createCopy/updateCopy, never an independent command or revision authority.
 * Call only after the existing writer's whole-copy revision and current-source checks.
 */
export function mergeCopyConditionFields(
  current: CopyConditionFacts,
  patch: CopyConditionPatch,
  acceptance: CopyConditionAcceptance,
): CopyConditionFacts {
  const submitted = parseCopyConditionFields(patch);
  if (!Object.keys(submitted).length) return current;
  if (copyConditionAdmission(acceptance.kind).state !== 'supported')
    throw new Error('Unsupported copy condition capability');
  const next = { ...current };
  for (const field of ['mediaCondition', 'packagingCondition'] as const) {
    if (!Object.hasOwn(submitted, field)) continue;
    const value = submitted[field];
    // parseCopyConditionFields rejects an explicitly supplied undefined.
    if (value === undefined) throw new CopyConditionInvalidError(field);
    next[field] = { value, pin: { ...acceptance.pin }, kindId: acceptance.kind.id };
  }
  return next;
}

export type CopyConditionDisplay = Readonly<
  | { state: 'not_recorded' }
  | { state: 'unavailable' }
  | { state: 'cleared' }
  | { state: 'recorded'; id: CopyConditionValue; label: string }
>;

/** The caller resolves each observation's actual accepting pin, with deduplicated exact-release reads.
 * Current retirement cannot erase accepted display meaning. A missing exact release cannot supply a grade.
 */
export function presentCopyCondition(
  observation: CopyConditionObservation | undefined,
  acceptedKind: LibraryCopyKindDescriptor | null,
): CopyConditionDisplay {
  if (observation === undefined) return { state: 'not_recorded' };
  if (acceptedKind?.id !== observation.kindId || copyConditionAdmission(acceptedKind).state !== 'supported')
    return { state: 'unavailable' };
  if (observation.value === null) return { state: 'cleared' };
  const choice = COPY_CONDITION_CHOICES.find((candidate) => candidate.id === observation.value);
  return choice ? { state: 'recorded', id: choice.id, label: choice.label } : { state: 'unavailable' };
}
