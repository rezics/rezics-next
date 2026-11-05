import { type Actor } from '../request/access.ts';
import { type ContentReadDependencies, type NoticeBoardContext, type NoticePostContext } from './reads.ts';
export declare const DecisionPageSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    targetKind: import("typebox").TUnion<[import("typebox").TLiteral<"board">, import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">]>;
    targetId: import("typebox").TString;
    action: import("typebox").TLiteral<"takedown">;
    statement: import("typebox").TString;
    decidedAt: import("typebox").TString;
    appealDeadline: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    appeal: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        outcome: import("typebox").TUnion<[import("typebox").TLiteral<"upheld">, import("typebox").TLiteral<"reversed">, import("typebox").TNull]>;
        statement: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        resolvedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>, import("typebox").TNull]>;
    viewer: import("typebox").TObject<{
        affectedAuthor: import("typebox").TBoolean;
        observedAt: import("typebox").TString;
        appeal: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"permitted">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"not_affected_author">, import("typebox").TLiteral<"already_appealed">, import("typebox").TLiteral<"deadline_passed">, import("typebox").TLiteral<"command_unavailable">]>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unsupported">;
            reason: import("typebox").TLiteral<"board">;
        }>]>;
    }>;
    targetContext: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"available">;
        kind: import("typebox").TLiteral<"board">;
        boardId: import("typebox").TString;
        boardTitle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"available">;
        kind: import("typebox").TLiteral<"thread">;
        threadId: import("typebox").TString;
        postId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        boardId: import("typebox").TString;
        threadTitle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        boardTitle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"concealed">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
    }>]>;
}>;
type Advice = {
    state: 'permitted';
} | {
    state: 'unavailable';
    reason: 'not_affected_author' | 'already_appealed' | 'deadline_passed' | 'command_unavailable';
} | {
    state: 'unsupported';
    reason: 'board';
};
type TargetContext = ({
    state: 'available';
    kind: 'board';
} & NoticeBoardContext) | ({
    state: 'available';
    kind: 'thread';
} & NoticePostContext) | {
    state: 'concealed';
} | {
    state: 'unavailable';
};
/** Current HTTP envelope on the original exact decision. Optional header context
 * never admits target text. All foreign work releases checkout before the exact
 * final source/epoch and authority observation; cross-home atomicity is not implied. */
export declare function readDecisionPage(deps: ContentReadDependencies, id: string, request: Request, context: {
    actor: Actor;
    deadline: number;
}): Promise<{
    value: {
        id: string;
        targetKind: 'board' | 'thread' | 'post';
        targetId: string;
        action: 'takedown';
        statement: string;
        decidedAt: string;
        appealDeadline: string | null;
        appeal: {
            id: string;
            outcome: 'upheld' | 'reversed' | null;
            statement: string | null;
            resolvedAt: string | null;
        } | null;
    } & {
        viewer: {
            affectedAuthor: boolean;
            observedAt: string;
            appeal: Advice;
        };
        targetContext: TargetContext;
    };
    anchor: {
        partition: number;
        epoch: number;
        position: bigint;
    };
} | null>;
export {};
