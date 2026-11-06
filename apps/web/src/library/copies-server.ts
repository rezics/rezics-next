import type { KernelClient } from '@rezics/client';

export type NativeCopyList = NonNullable<Awaited<ReturnType<KernelClient['copies']['get']>>['data']>;
export type NativeCopyListQuery = NonNullable<NonNullable<Parameters<KernelClient['copies']['get']>[0]>['query']>;

export type NativeCopy = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['copies']>['get']>>['data']>['copy'];
export type NativeCopyPresentation = NonNullable<NativeCopy['presentation']>;
// The decoded view carries labels and status choices only; the web does not read condition facts yet.
export type DecodedCopyPresentation = Omit<
  NativeCopyPresentation,
  'mediaCondition' | 'packagingCondition' | 'conditionEditing'
>;
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

function isPresentation(value: unknown): value is DecodedCopyPresentation {
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
    isStatusEditing(value.statusEditing)
  );
}

/** Decode only the declared owner DTO; current choices never supply historical labels. */
export function nativeCopyPresentation(copy: NativeCopy): DecodedCopyPresentation {
  const presentation = copy.presentation;
  if (!isPresentation(presentation)) return { meaning: 'unavailable', statusEditing: { state: 'unavailable' } };
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
  };
}
