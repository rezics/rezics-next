import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access } from '../request/access.ts';
import type { ContentEditionSaleAuthority } from './edition-model.ts';
import type { EditionRow } from './edition-store.ts';
import type { ReadContext } from './model.ts';

export type { ContentEditionConsentReader } from './edition-sale-native.ts';

// Commerce imports this port while initializing its catalogue. Defer the native
// Content/community/Access dependency graph until a read actually starts.
export async function readContentEditionSaleAuthority(
  dependencies: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  editionId: string,
  context: ReadContext,
): Promise<ContentEditionSaleAuthority | null> {
  const native = await import('./edition-sale-native.ts');
  return native.readContentEditionSaleAuthority(dependencies, editionId, context);
}

/** Server-only Commerce eligibility port. It never authorizes delivery to a buyer. */
export async function readContentEditionMechanicalSaleAuthority(
  dependencies: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  editionId: string,
  context: Readonly<{ deadline: number }>,
): Promise<ContentEditionSaleAuthority | null> {
  const native = await import('./edition-sale-native.ts');
  return native.readContentEditionMechanicalSaleAuthority(dependencies, editionId, context);
}

export async function prepareContentEditionSale(
  dependencies: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  editionId: string,
  context: ReadContext,
  time: AuthoritativeTime,
): Promise<Readonly<{
  row: EditionRow;
  authority: ContentEditionSaleAuthority;
  final(): Promise<boolean>;
}> | null> {
  const native = await import('./edition-sale-native.ts');
  return native.prepareContentEditionSale(dependencies, editionId, context, time);
}
