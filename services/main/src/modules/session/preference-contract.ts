import { t } from 'elysia';
import type { Static } from 'typebox';
import { readId, readLanguage } from '../work/read-contract.ts';

export const EDITION_PREFERENCE_COST = { writeSql: 12 } as const;
// A retained release may have no realization-language correspondence. Only a
// release pin may retain null; its bibliographic content languages stay intact.
export const editionChoice = t.Object({ language: t.Nullable(readLanguage),
  edition: t.Nullable(t.Object({ kind: t.Union([t.Literal('realization'), t.Literal('release')]),
    resource: readId, revision: readId }, { additionalProperties: false })) }, { additionalProperties: false });
export type EditionChoice = Static<typeof editionChoice>;
export const editionPreference = t.Object({ work: readId, ...editionChoice.properties,
  version: t.Integer({ minimum: 0 }) }, { additionalProperties: false });
export type EditionPreference = Static<typeof editionPreference>;
export class InvalidEditionPreference extends Error {}
export class StaleEditionPreference extends Error {
  constructor(readonly current: EditionPreference | null) { super('Edition preference changed'); }
}
export class EditionPreferenceConflict extends Error {}
