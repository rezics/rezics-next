import type { OpenLibraryConversion } from './open-library-conversion.ts';
import type { StagedSourceObservation } from './intake.ts';

/** Accepted explicit-conversion output; reads revalidate its retained byte binding. */
export interface MappedSourceValue {
  grain: string; field: string; pointer: string; slot: string; value: unknown;
}
export interface MappedSourceChild {
  sourceKey: string; roleKey: string | null; pointer: string; value: unknown;
}
export interface MappedSourceValues {
  title: MappedSourceValue & { value: string };
  semanticTypes: string[];
  fields: MappedSourceValue[];
  children: Array<{ field: string; grain: string; slot: string | null;
    values: MappedSourceChild[] | null }>;
  sourceOnlyFields: string[];
}
export interface MappedSourceConversion {
  profile: 'source-mapped-conversion-v1'; state: 'staged'; conversion: string;
  observation: string; mappingRevision: string; sourceDigest: string;
  projection: MappedSourceValues;
  fieldInventory: Array<{ grain: string; field: string; disposition: string; reason?: string }>;
  createdAt: string;
}
export interface VerifiedMappedSource {
  conversion: MappedSourceConversion;
  observation: StagedSourceObservation;
  values: MappedSourceValues;
  legacy?: OpenLibraryConversion;
}
export interface MappedConversionReader {
  mappedRead(principalId: string, conversionId: string): Promise<VerifiedMappedSource | null>;
}
export const MAPPING_REVISION = /^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}$/;
export const CHILD_FIELD = /^[A-Za-z][A-Za-z0-9:_.-]{0,99}$/;

/** A sealed field declaration is the common native-slot boundary for every Source writer. */
export function mappedNativeDisposition(declaration: { disposition: string; native_target: string | null },
  slot: string | null): boolean {
  return slot !== null && declaration.native_target === slot
    && ['native', 'lossy'].includes(declaration.disposition);
}

