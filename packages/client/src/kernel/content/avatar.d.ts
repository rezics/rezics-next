import type { PoolClient } from 'pg';
export type AvatarSummary = Readonly<{
    media: string;
    width: number;
    height: number;
    placeholder: Readonly<{
        thumbhash: string;
        color: string;
    }>;
    variants: readonly Readonly<{
        format: 'avif' | 'webp';
        width: number;
    }>[];
    focalPoint: Readonly<{
        x: number;
        y: number;
    }> | null;
    credit: null;
}>;
/** Access calls this fact read on the account's transaction when setting its avatar. */
export declare function checkAvatarMedia(client: Pick<PoolClient, 'query'>, mediaId: string, accountId: string): Promise<boolean>;
/** One statement per media partition; unavailable or malformed identities remain null. */
export declare function readAvatarSummaries(client: Pick<PoolClient, 'query'>, ids: readonly string[]): Promise<Map<string, AvatarSummary | null>>;
