import type { Pool } from 'pg';
import { type KindCataloguePin, type PinnedKindDeclaration } from '@rezics/definitions';
import { type Actor, type Access } from '../request/access.ts';
import { type AccessWorkAccounting } from '../access/work.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type CatalogueBuildStatus } from './definition-catalogue-publication.ts';
export type DefinitionCatalogueReadContext = Readonly<{
    actor: Actor;
    deadline: number;
    work: AccessWorkAccounting;
}>;
type Page = Readonly<{
    pin: KindCataloguePin;
    limit?: number;
    cursor: string | null;
}>;
export interface NativeDefinitionCatalogue {
    head(context: DefinitionCatalogueReadContext): Promise<Readonly<{
        pin: KindCataloguePin;
        head: number;
    }> | null>;
    kinds(input: Readonly<{
        pin: KindCataloguePin;
        ids: readonly string[];
    }>, context: DefinitionCatalogueReadContext): Promise<readonly Readonly<{
        id: string;
        value: PinnedKindDeclaration | null;
    }>[]>;
    kindPage(input: Page & Readonly<{
        query: string;
        language: string;
    }>, context: DefinitionCatalogueReadContext): Promise<Readonly<{
        kinds: readonly PinnedKindDeclaration[];
        next: string | null;
    }>>;
    kindCandidates(input: Page & Readonly<{
        exactTypeId: string;
    }>, context: DefinitionCatalogueReadContext): Promise<Readonly<{
        candidates: readonly PinnedKindDeclaration[];
        next: string | null;
    }>>;
    build(input: {
        pin: KindCataloguePin;
    }, context: DefinitionCatalogueReadContext): Promise<CatalogueBuildStatus | null>;
}
export declare const DEFINITION_CATALOGUE_READ_KEY_BOUND: number;
/** Ordinary host composition supplies its existing cursor key ring; this never grants read authority. */
export declare function configureDefinitionCatalogue(pool: Pool, keys: KeyRing): void;
export declare const cataloguePin: (rootDigest: string) => KindCataloguePin;
export declare function createNativeDefinitionCatalogue({ pool, access, }: Readonly<{
    pool: Pool;
    access: Access;
}>): NativeDefinitionCatalogue;
export {};
