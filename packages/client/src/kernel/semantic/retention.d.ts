import type { Pool } from 'pg';
export type RetentionPage = Readonly<{
    examined: number;
    purged: number;
    checkpoint: string | null;
    done: boolean;
}>;
export type RetentionInput = Readonly<{
    partition: number;
    limit: number;
    key: string;
}>;
/** Same small native adapter used by acceptance and default scheduled work. All writes and the page
 * receipt commit in one source-home command; preparation releases every source checkout before entry.
 */
export declare function semanticRetention(pool: Pool, options?: Readonly<{
    clock?: () => Date;
}>): {
    step(input: RetentionInput): Promise<RetentionPage>;
};
