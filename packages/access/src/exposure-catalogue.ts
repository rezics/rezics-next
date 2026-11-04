import type { Exposure } from './exposure-contract.ts';

export type ExposureOperation = Readonly<{
  method: string;
  path: string;
  operationId: string;
  action: string;
  exposure: Exposure;
}>;

export type ExposureCatalogue = Readonly<{
  operations: readonly ExposureOperation[];
  groups: readonly string[];
  digestEntries: readonly string[];
}>;

/** Compile trusted, normalized deployment facts without deriving policy from route labels. */
export function compileExposureCatalogue(operations: readonly ExposureOperation[]): ExposureCatalogue {
  const normalized = Object.freeze(
    operations.map((operation) => {
      const exposure =
        operation.exposure.kind === 'public'
          ? Object.freeze({ kind: 'public' as const })
          : Object.freeze({ kind: 'gate' as const, group: operation.exposure.group });
      return Object.freeze({ ...operation, exposure });
    }),
  );
  const groups = Object.freeze(
    [
      ...new Set(
        normalized.flatMap((operation) => (operation.exposure.kind === 'gate' ? [operation.exposure.group] : [])),
      ),
    ].sort(),
  );
  const digestEntries = Object.freeze(
    normalized
      .map((operation) =>
        JSON.stringify([
          operation.method,
          operation.path,
          operation.operationId,
          operation.action,
          operation.exposure,
        ])!,
      )
      .sort(),
  );
  return Object.freeze({ operations: normalized, groups, digestEntries });
}
