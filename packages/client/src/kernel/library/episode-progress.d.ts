import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { LibraryProfilePin } from './profile.ts';
export declare const MAX_EPISODE_IDS = 20;
export type EpisodeProgressIntent = {
    revision: number;
    add: string[];
    remove: string[];
    clear: boolean;
};
export type EpisodeCompletion = {
    episodeSubjectId: string | null;
    completed: boolean | null;
    membership: 'member' | 'detached' | 'unavailable';
    ordinal: string | null;
};
export type EpisodeProgressView = {
    revision: number;
    episodes: EpisodeCompletion[];
    next: string | null;
};
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    routeKey: Uint8Array;
    clock?: KernelClock;
};
type ExpectedProgressBinding = {
    subjectId: string;
    requestedSubjectId: string | null;
    acceptingType: string;
    identityEpoch: string;
    component: {
        partition: number;
        epoch: number;
        position: string;
    };
    profilePin: Extract<LibraryProfilePin, {
        provenance: 'profile';
    }>;
};
/** Lowercase canonical UUIDs only; ordinals and legacy sparse tokens never enter this set. */
export declare function episodeIds(value: unknown): string[];
export declare function episodeIntent(input: unknown): EpisodeProgressIntent;
/** Canonical completion is orthogonal to the existing session's scalar/cursor/manual value. */
export declare function createEpisodeProgressCommands(config: Dependencies): {
    recordEpisodes: (actor: Actor, sessionId: string, input: unknown, requestKey: string, expected?: ExpectedProgressBinding) => Promise<import("../command/command.ts").CommandOutcome<{
        revision: number;
    }>>;
    readEpisodes: (actor: Actor, sessionId: string, options?: {
        ids?: string[];
        cursor?: string;
        limit?: number;
    }) => Promise<EpisodeProgressView>;
};
export {};
