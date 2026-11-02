import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import type { CoverSummary } from '../semantic/summaries.ts';
import { type CollectionKind } from './collection-kind.ts';
export type PresentationSelection = {
    presentationKind?: string | null;
    coverMediaId?: string | null;
};
export type CollectionPresentation = {
    presentationKind: CollectionKind['presentationKind'];
    presentationKindSource: CollectionKind['presentationKindSource'];
    cover: CoverSummary | null;
    coverSource: 'owner' | 'member' | 'none' | 'pending';
    coverMediaId?: string | null;
};
export type PresentationDependencies = {
    pool: Pool;
    access: Access;
    routeKey?: Uint8Array;
    clock?: KernelClock;
};
/** Syntactic admission only. Semantic existence/readability is deferred until after native authorization. */
export declare function presentationSelection(input: PresentationSelection): PresentationSelection;
/** Facts and authority are independent. Each Content operation releases its own anchor before the next. */
export declare function readablePresentationCover(dependencies: PresentationDependencies, actor: Actor, id: string, deadline: number): Promise<CoverSummary | null>;
/** Preparation returns business errors as data: exact receipts still follow current Collection authorization. */
export declare function preparePresentationSelection(dependencies: PresentationDependencies, actor: Actor, selection: PresentationSelection, deadline: number): Promise<ProblemError | null>;
/** Kind presentation is immediate; ordered cover readiness keeps its independent contract. */
export declare function collectionPresentation(row: {
    presentationKind: string | null;
    memberCount: number;
    membershipKind?: string;
}, cover?: CoverSummary | null): Omit<CollectionPresentation, 'coverMediaId'>;
