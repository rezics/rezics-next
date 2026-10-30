import type { Pool } from 'pg';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { Access } from '../request/access.ts';
import type { ContentEditionSaleAuthority } from './edition-model.ts';
import type { ReadContext } from './model.ts';

/** Agreed owner entrypoint. Replace this unavailable declaration with the native
 * Content implementation; publication metadata alone cannot verify current sale authority.
 */
export async function readContentEditionSaleAuthority(
  _dependencies: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  _editionId: string,
  _context: ReadContext,
): Promise<ContentEditionSaleAuthority | null> {
  throw new AccessUnavailableError('overloaded');
}

/** Server-only owner entrypoint. The pending native implementation must restore
 * the real original publisher independently for edition:sell and post:revise.
 */
export async function readContentEditionMechanicalSaleAuthority(
  _dependencies: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  _editionId: string,
  _context: Readonly<{ deadline: number }>,
): Promise<ContentEditionSaleAuthority | null> {
  throw new AccessUnavailableError('overloaded');
}
