import type { CopyConditionPresentation, CopyInventoryOptions, KernelClient } from '@rezics/client';
import { COPY_CONDITION_VALUES } from '@rezics/client';

export type NativeCopyList = NonNullable<Awaited<ReturnType<KernelClient['copies']['get']>>['data']>;
export type NativeCopyListQuery = NonNullable<NonNullable<Parameters<KernelClient['copies']['get']>[0]>['query']>;

export type NativeCopy = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['copies']>['get']>>['data']>['copy'];
export type NativeCopyPresentation = NonNullable<NativeCopy['presentation']>;
type DetailOptions = NonNullable<Parameters<ReturnType<KernelClient['copies']>['get']>[0]>;
export type CopyDetailQuery = NonNullable<DetailOptions['query']>;

export function nativeCopyPresentationQuery(): Required<Pick<CopyDetailQuery, 'presentation'>> {
  return { presentation: 'FULL' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function labelPair(value: Record<string, unknown>, label: string, language: string): boolean {
  return (
    (value[label] === undefined && value[language] === undefined) ||
    (typeof value[label] === 'string' && typeof value[language] === 'string')
  );
}

function isStatusEditing(value: unknown): value is NativeCopyPresentation['statusEditing'] {
  if (!isRecord(value)) return false;
  if (value.state === 'unsupported' || value.state === 'unavailable') return onlyKeys(value, ['state']);
  return (
    value.state === 'supported' &&
    onlyKeys(value, ['state', 'statuses']) &&
    Array.isArray(value.statuses) &&
    value.statuses.length > 0 &&
    value.statuses.every(
      (choice: unknown) =>
        isRecord(choice) &&
        onlyKeys(choice, ['id', 'label', 'labelLanguage']) &&
        typeof choice.id === 'string' &&
        typeof choice.label === 'string' &&
        typeof choice.labelLanguage === 'string',
    )
  );
}

function isConditionValue(value: unknown): value is (typeof COPY_CONDITION_VALUES)[number] {
  return typeof value === 'string' && (COPY_CONDITION_VALUES as readonly string[]).includes(value);
}

function isConditionDisplay(value: unknown): value is CopyConditionPresentation['mediaCondition'] {
  if (!isRecord(value)) return false;
  if (value.state === 'not_recorded' || value.state === 'unavailable' || value.state === 'cleared')
    return onlyKeys(value, ['state']);
  return (
    value.state === 'recorded' &&
    onlyKeys(value, ['state', 'id', 'label']) &&
    isConditionValue(value.id) &&
    typeof value.label === 'string'
  );
}

function isConditionEditing(value: unknown): value is CopyConditionPresentation['conditionEditing'] {
  if (!isRecord(value)) return false;
  if (value.state === 'supported') {
    return (
      value.currentness === 'current' &&
      onlyKeys(value, ['state', 'currentness', 'choices']) &&
      Array.isArray(value.choices) &&
      value.choices.length === COPY_CONDITION_VALUES.length &&
      value.choices.every(
        (choice: unknown) =>
          isRecord(choice) &&
          onlyKeys(choice, ['id', 'label', 'description']) &&
          isConditionValue(choice.id) &&
          typeof choice.label === 'string' &&
          typeof choice.description === 'string',
      )
    );
  }
  return (
    value.state === 'unavailable' &&
    onlyKeys(value, ['state', 'currentness', 'reason']) &&
    (value.currentness === 'current' || value.currentness === 'retired' || value.currentness === 'unavailable') &&
    (value.reason === 'unsupported' ||
      value.reason === 'unrecognized_vocabulary' ||
      value.reason === 'retired' ||
      value.reason === 'current_source_unavailable')
  );
}

function isPresentation(value: unknown): value is NativeCopyPresentation {
  return (
    isRecord(value) &&
    onlyKeys(value, [
      'meaning',
      'kindLabel',
      'kindLabelLanguage',
      'statusLabel',
      'statusLabelLanguage',
      'statusEditing',
      'mediaCondition',
      'packagingCondition',
      'conditionEditing',
    ]) &&
    (value.meaning === 'known' || value.meaning === 'unknown' || value.meaning === 'unavailable') &&
    labelPair(value, 'kindLabel', 'kindLabelLanguage') &&
    labelPair(value, 'statusLabel', 'statusLabelLanguage') &&
    isStatusEditing(value.statusEditing) &&
    (value.mediaCondition === undefined || isConditionDisplay(value.mediaCondition)) &&
    (value.packagingCondition === undefined || isConditionDisplay(value.packagingCondition)) &&
    (value.conditionEditing === undefined || isConditionEditing(value.conditionEditing))
  );
}

const omittedCondition = {
  mediaCondition: { state: 'not_recorded' },
  packagingCondition: { state: 'not_recorded' },
  conditionEditing: { state: 'unavailable', currentness: 'unavailable', reason: 'current_source_unavailable' },
} satisfies CopyConditionPresentation;

function conditionPresentation(
  presentation: NativeCopyPresentation,
): Pick<NativeCopyPresentation, 'mediaCondition' | 'packagingCondition' | 'conditionEditing'> {
  return {
    mediaCondition: presentation.mediaCondition ?? omittedCondition.mediaCondition,
    packagingCondition: presentation.packagingCondition ?? omittedCondition.packagingCondition,
    conditionEditing:
      presentation.conditionEditing.state === 'supported'
        ? { ...presentation.conditionEditing, choices: [...presentation.conditionEditing.choices] }
        : presentation.conditionEditing,
  };
}

/** Decode only the declared owner DTO; current choices never supply historical labels. */
export function nativeCopyPresentation(copy: NativeCopy): NativeCopyPresentation {
  const presentation = copy.presentation;
  if (!isPresentation(presentation))
    return { meaning: 'unavailable', statusEditing: { state: 'unavailable' }, ...omittedCondition };
  const { meaning, statusEditing } = presentation;
  return {
    meaning,
    ...(meaning === 'known'
      ? {
          ...(presentation.kindLabel === undefined || presentation.kindLabelLanguage === undefined
            ? {}
            : { kindLabel: presentation.kindLabel, kindLabelLanguage: presentation.kindLabelLanguage }),
          ...(presentation.statusLabel === undefined || presentation.statusLabelLanguage === undefined
            ? {}
            : { statusLabel: presentation.statusLabel, statusLabelLanguage: presentation.statusLabelLanguage }),
        }
      : {}),
    // Advice cannot establish support without the original meaning, and is never write authority.
    statusEditing:
      statusEditing.state === 'supported'
        ? meaning === 'known'
          ? { state: 'supported', statuses: statusEditing.statuses.map((choice) => ({ ...choice })) }
          : { state: 'unavailable' }
        : { state: statusEditing.state },
    ...conditionPresentation(presentation),
  };
}

function isInventoryChoice(value: unknown): value is CopyInventoryOptions['kinds']['choices'][number] {
  return (
    isRecord(value) &&
    onlyKeys(value, ['id', 'label', 'labelLanguage', 'meaning']) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    (value.labelLanguage === undefined || typeof value.labelLanguage === 'string') &&
    (value.meaning === 'available' || value.meaning === 'unsupported' || value.meaning === 'unavailable')
  );
}

function isInventoryFacet(value: unknown): value is CopyInventoryOptions['kinds'] {
  return (
    isRecord(value) &&
    onlyKeys(value, ['state', 'choices']) &&
    (value.state === 'available' || value.state === 'unavailable') &&
    Array.isArray(value.choices) &&
    value.choices.every(isInventoryChoice)
  );
}

/** Malformed native options grant no filter capability. */
export function nativeCopyInventory(page: NativeCopyList): CopyInventoryOptions | undefined {
  if (!('filterOptions' in page) || !isRecord(page.filterOptions)) return undefined;
  const value = page.filterOptions;
  if (!onlyKeys(value, ['kinds', 'statuses']) || !isInventoryFacet(value.kinds) || !isInventoryFacet(value.statuses))
    return undefined;
  return {
    kinds: {
      state: value.kinds.state,
      choices: value.kinds.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        ...(choice.labelLanguage === undefined ? {} : { labelLanguage: choice.labelLanguage }),
        meaning: choice.meaning,
      })),
    },
    statuses: {
      state: value.statuses.state,
      choices: value.statuses.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        ...(choice.labelLanguage === undefined ? {} : { labelLanguage: choice.labelLanguage }),
        meaning: choice.meaning,
      })),
    },
  };
}
