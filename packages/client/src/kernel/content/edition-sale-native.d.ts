import { type CurrentConsentReader } from '../access/auth-consent.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { ContentEditionSaleDependencies } from './edition-sale.ts';
import type { ContentEditionSaleAuthority } from './edition-model.ts';
import type { ReadContext } from './model.ts';
import { type EditionRow } from './edition-store.ts';
/** Trusted composition builds this once from Auth configuration; absent configuration yields no reader. */
export type ContentEditionConsentReader = CurrentConsentReader;
export declare function readContentEditionConsent(env: Readonly<Record<string, string | undefined>>): ContentEditionConsentReader | undefined;
type Dependencies = ContentEditionSaleDependencies;
/** Server-only Commerce eligibility port. It never authorizes delivery to a buyer. */
export declare function readContentEditionMechanicalSaleAuthority(dependencies: Dependencies, editionId: string, context: Readonly<{
    deadline: number;
}>): Promise<ContentEditionSaleAuthority | null>;
/** Current seller restoration uses the actual Auth configuration and two independent actions.
 * The request actor remains the buyer for every parent/Realm/Space read. */
export declare function prepareContentEditionSale(deps: Dependencies, editionId: string, context: ReadContext, time: AuthoritativeTime): Promise<Readonly<{
    row: EditionRow;
    authority: ContentEditionSaleAuthority;
    final(): Promise<boolean>;
}> | null>;
export declare function readContentEditionSaleAuthority(dependencies: Dependencies, editionId: string, context: ReadContext): Promise<ContentEditionSaleAuthority | null>;
export {};
