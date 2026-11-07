import type { ReleaseViolation } from '@rezics/definitions';

/** Definition publication and extension commands share the same error identities. */
export class DefinitionInputError extends Error {
  constructor(readonly violations: ReleaseViolation[]) {
    super('Invalid definition release');
  }
}
export class DefinitionAccessDeniedError extends Error {}
export class DefinitionNotFoundError extends Error {}
export class StaleEditorialHeadError extends Error {}
