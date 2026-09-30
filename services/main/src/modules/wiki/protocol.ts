/** The only Main import boundary into the independently Apache-licensed protocol. */
import Type from 'typebox';
export * from '@rezics/wiki-toolkit/protocol';
export { checkLocator, type Locator } from '@rezics/wiki-toolkit/protocol';

/** Main resolves native resources; the published protocol permits other hosts. */
export const WikiNativeResourceSchema = Type.String({ maxLength: 128,
  pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'x-wiki-iri': true });
