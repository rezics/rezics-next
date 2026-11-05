import type { Pool } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
import { type RealmParticipationCheck } from '../community/participation.ts';
import { REACTION_KINDS } from './events.ts';
import type { RequestContext } from './model.ts';
export { REACTION_KINDS };
export type ReactionKind = (typeof REACTION_KINDS)[number];
export type ReactionDependencies = Readonly<{
    pool: Pool;
    access: Access;
    realmParticipation?: RealmParticipationCheck;
    clock?: () => Date;
}>;
export type ReactionTarget = Readonly<{
    targetKind: 'thread' | 'post' | 'subject';
    targetId: string;
}>;
export type SetReactionInput = ReactionTarget & Readonly<{
    kind: ReactionKind;
}>;
/** Every accepted set or clear retains its original command receipt, including an unchanged slot. */
export declare function setReaction(deps: ReactionDependencies, actor: Actor, input: SetReactionInput, context: RequestContext): Promise<import("../command/command.ts").CommandOutcome<{
    targetKind: "post" | "subject" | "thread";
    targetId: string;
    kind: "downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote" | null;
}>>;
export declare function clearReaction(deps: ReactionDependencies, actor: Actor, input: ReactionTarget, context: RequestContext): Promise<import("../command/command.ts").CommandOutcome<{
    targetKind: "post" | "subject" | "thread";
    targetId: string;
    kind: "downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote" | null;
}>>;
