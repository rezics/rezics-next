import { COPY_CONDITION_VALUES, type CopyConditionDisplay, type CopyConditionValue } from '@rezics/client';
import { m } from '../paraglide/messages.js';

export const COPY_CONDITION_CLEAR = '__clear__';
export type CopyConditionDraft = { mediaCondition: string; packagingCondition: string };

const labels: Record<CopyConditionValue, () => string> = {
  unknown: () => m.library_copy_condition_unknown(),
  mint: () => m.library_copy_condition_mint(),
  near_mint: () => m.library_copy_condition_near_mint(),
  very_good_plus: () => m.library_copy_condition_very_good_plus(),
  very_good: () => m.library_copy_condition_very_good(),
  good: () => m.library_copy_condition_good(),
  fair: () => m.library_copy_condition_fair(),
  poor: () => m.library_copy_condition_poor(),
};

export function copyConditionChoices() {
  return COPY_CONDITION_VALUES.map((id) => ({ id, label: labels[id]() }));
}

export function copyConditionDisplayText(display: CopyConditionDisplay | undefined): string {
  if (!display || display.state === 'not_recorded') return m.library_copy_condition_not_recorded();
  if (display.state === 'unavailable') return m.library_copy_condition_unavailable();
  if (display.state === 'cleared') return m.library_copy_condition_cleared();
  return display.label;
}

export function copyConditionDraftOf(display: CopyConditionDisplay | undefined): string {
  if (!display || display.state === 'not_recorded' || display.state === 'unavailable') return '';
  if (display.state === 'cleared') return COPY_CONDITION_CLEAR;
  return display.id;
}

export function copyConditionOperand(value: string): CopyConditionValue | null | undefined {
  if (value === '') return undefined;
  if (value === COPY_CONDITION_CLEAR) return null;
  return COPY_CONDITION_VALUES.includes(value as CopyConditionValue) ? (value as CopyConditionValue) : undefined;
}

export function kindAdmitsCondition(condition: unknown): boolean {
  return condition === 'physical-v1';
}

export function copyConditionWritten(
  previous: CopyConditionDisplay | undefined,
  value: CopyConditionValue | null | undefined,
): CopyConditionDisplay | undefined {
  if (value === undefined) return previous;
  if (value === null) return { state: 'cleared' };
  return {
    state: 'recorded',
    id: value,
    label: copyConditionChoices().find((choice) => choice.id === value)?.label ?? value,
  };
}
