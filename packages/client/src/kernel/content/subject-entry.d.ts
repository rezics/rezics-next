import type { Actor } from '../request/access.ts';
import type { AnchoredPosition, BoardView, ReadContext } from './model.ts';
import type { ContentCommandDependencies } from './commands.ts';
import { type ContentReadDependencies } from './reads.ts';
import type { SubjectThreadContext } from './subject-threads-context.ts';
export type BoardEntryAdvice = 'allowed' | 'denied' | 'sign-in' | 'unavailable';
type SubjectThreadEntryRequestBase = Readonly<{
    subjectId: string;
    placeId: string;
    kind: SubjectThreadContext['kind'];
}>;
export type SubjectThreadEntryRequest = (SubjectThreadEntryRequestBase & Readonly<{
    selectedBoardId?: undefined;
}>) | (SubjectThreadEntryRequestBase & Readonly<{
    selectedBoardId: string;
}>);
type SelectedEntryRequest = SubjectThreadEntryRequestBase & Readonly<{
    selectedBoardId: string;
}>;
export type SubjectThreadEntry = Readonly<{
    state: 'not_selected';
    request: SubjectThreadEntryRequestBase & Readonly<{
        selectedBoardId?: undefined;
    }>;
}> | Readonly<{
    state: 'concealed';
    request: SelectedEntryRequest;
}> | Readonly<{
    state: 'unavailable';
    request: SelectedEntryRequest;
}> | Readonly<{
    state: 'current';
    request: SelectedEntryRequest;
    board: BoardView;
    actions: Readonly<{
        createThread: BoardEntryAdvice;
    }>;
    observations: Readonly<{
        subject: SubjectThreadContext['subject']['source'];
        place: SubjectThreadContext['place'];
        board: Readonly<{
            initial: SourcePosition;
            final: SourcePosition;
        }>;
        access: Readonly<{
            initial: readonly SourcePosition[];
            final: readonly SourcePosition[];
        }>;
    }>;
}>;
export type SourcePosition = Readonly<{
    partition: number;
    epoch: number;
    position: string;
}>;
export type SubjectThreadEntryDependencies = ContentReadDependencies & Pick<ContentCommandDependencies, 'realmParticipation'>;
type EntryFinish = Readonly<{
    entry: SubjectThreadEntry;
    anchors: readonly AnchoredPosition[];
}>;
export declare function projectSubjectThreadCreateAdvice(actor: Actor, participation: BoardEntryAdvice, allowed: boolean): BoardEntryAdvice;
/** Prepares advice only for the caller's exact selected Board. The final read reuses
 * the Board page's read/action evidence factories after Subject cards and media work. */
export declare function prepareSubjectThreadEntry(dependencies: SubjectThreadEntryDependencies, subjectContext: SubjectThreadContext, selectedBoardId: string | undefined, context: ReadContext): Promise<Readonly<{
    initial: SubjectThreadEntry;
    finish(): Promise<EntryFinish>;
}>>;
export {};
