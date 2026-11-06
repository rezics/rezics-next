import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { AccessClient } from '../request/access.ts';
import type { ReadContext, Anchored } from './model.ts';
import type { ContentEditionView, ContentEditionBenefit, ContentEditionSource } from './edition-model.ts';
export type EditionRow = {
    route: number;
    edition_id: string;
    target_subject_id: string;
    creator_account_id: string;
    thread_id: string;
    post_id: string;
    revision_id: string;
    sha256: string;
    licence: string;
    state: 'draft' | 'published' | 'unpublished';
    security_revision: string;
    recorded_transaction_id: string;
    created_at: string;
    inserted_here: boolean;
};
export type EditionDependencies = Readonly<{
    pool: Pool;
    clock: () => Date;
}>;
/** Released, home-anchored bounded snapshots, including the final byte guard. */
export declare function editionSnapshot<T>(deps: EditionDependencies, id: string, context: Pick<ReadContext, 'deadline'>, read: (client: AccessClient) => Promise<T>): Promise<Anchored<T>>;
/** Reads own the time lifetime; commands use only the executor's attempt time. */
export declare function withEditionReadTime<T>(deps: EditionDependencies, context: Pick<ReadContext, 'deadline'>, read: (time: AuthoritativeTime) => Promise<T>): Promise<T>;
export declare function editionRow(client: AccessClient, id: string): Promise<EditionRow | null>;
/** Native exact revision and its original writer, never a history search or current head substitute. */
export declare function editionSource(client: AccessClient, postId: string, revisionId: string, targetSubjectId: string): Promise<ContentEditionSource | null>;
export declare function sourceOf(row: EditionRow): ContentEditionSource;
export declare function sameSource(a: ContentEditionSource | null, b: ContentEditionSource): boolean;
export declare function sameEdition(a: EditionRow | null, b: EditionRow): a is EditionRow;
export declare function editionBenefit(row: EditionRow): ContentEditionBenefit;
export declare function editionMetadata(row: EditionRow): ContentEditionView;
export declare function editionDigest(value: unknown): string;
