import type { ComponentType, ReactNode } from 'react';
import type { FilterDocument } from '@rezics/filter';
import type { ConditionMetadata } from '../../search/contracts/condition-metadata';

/** Library contributes owner leaves; Search owns the one Boolean tree editor and released grammar. */
export type SavedQueryOwnerExtension = {
  choices: { label: string; value: FilterDocument }[];
  label?(value: FilterDocument, context?: { locale: string }): string | undefined;
  render(
    value: FilterDocument,
    onChange: (value: FilterDocument) => void,
    context?: { pointer: string; locale: string; issues: readonly { pointer: string; code: string }[] },
  ): ReactNode;
};

export type SavedQueryConditionInputProps = {
  value: FilterDocument | undefined;
  onChange(value: FilterDocument | undefined): void;
  locale: string;
  metadata: ConditionMetadata;
  extension: SavedQueryOwnerExtension;
};

export type SavedQueryConditionInput = ComponentType<SavedQueryConditionInputProps>;
