import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access } from '../request/access.ts';
import type { ContentEditionSaleAuthority } from './edition-model.ts';
import type { EditionRow } from './edition-store.ts';
import type { ReadContext } from './model.ts';
import type { ContentRuntime } from './runtime.ts';
export type ContentEditionSaleDependencies = Readonly<{
    pool: Pool;
    access: Access;
    clock: () => Date;
}> & Pick<ContentRuntime, 'readConsent' | 'editionPublisherAccess'>;
export type { ContentEditionConsentReader } from './edition-sale-native.ts';
export declare function readContentEditionSaleAuthority(dependencies: ContentEditionSaleDependencies, editionId: string, context: ReadContext): Promise<ContentEditionSaleAuthority | null>;
/** Server-only Commerce eligibility port. It never authorizes delivery to a buyer. */
export declare function readContentEditionMechanicalSaleAuthority(dependencies: ContentEditionSaleDependencies, editionId: string, context: Readonly<{
    deadline: number;
}>): Promise<ContentEditionSaleAuthority | null>;
export declare function prepareContentEditionSale(dependencies: ContentEditionSaleDependencies, editionId: string, context: ReadContext, time: AuthoritativeTime): Promise<Readonly<{
    row: EditionRow;
    authority: ContentEditionSaleAuthority;
    final(): Promise<boolean>;
}> | null>;
