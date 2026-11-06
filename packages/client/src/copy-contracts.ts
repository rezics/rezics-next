/** Copy condition and inventory DTOs mounted beside the generated copies routes. Loan contracts derive from the
 * generated copy-loans route in index.ts, so this module carries no loan types.
 */

export const COPY_CONDITION_VALUES = [
  'unknown',
  'mint',
  'near_mint',
  'very_good_plus',
  'very_good',
  'good',
  'fair',
  'poor',
] as const;

export type CopyConditionValue = (typeof COPY_CONDITION_VALUES)[number];
export type CopyConditionPatch = {
  mediaCondition?: CopyConditionValue | null;
  packagingCondition?: CopyConditionValue | null;
};

export type CopyConditionDisplay =
  | { state: 'not_recorded' }
  | { state: 'unavailable' }
  | { state: 'cleared' }
  | { state: 'recorded'; id: CopyConditionValue; label: string };

export type CopyConditionChoice = { id: CopyConditionValue; label: string; description: string };
export type CopyConditionEditing =
  | { state: 'supported'; currentness: 'current'; choices: readonly CopyConditionChoice[] }
  | {
      state: 'unavailable';
      currentness: 'current' | 'retired' | 'unavailable';
      reason: 'unsupported' | 'unrecognized_vocabulary' | 'retired' | 'current_source_unavailable';
    };

export type CopyConditionPresentation = {
  mediaCondition: CopyConditionDisplay;
  packagingCondition: CopyConditionDisplay;
  conditionEditing: CopyConditionEditing;
};

export type CopyInventoryChoice = {
  id: string;
  label: string;
  labelLanguage?: string;
  meaning: 'available' | 'unsupported' | 'unavailable';
};
export type CopyInventoryFacet = { state: 'available' | 'unavailable'; choices: CopyInventoryChoice[] };
export type CopyInventoryOptions = { kinds: CopyInventoryFacet; statuses: CopyInventoryFacet };
