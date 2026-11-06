import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import { type ViewerActionBindings, type ViewerActionResources } from '../access/viewer-actions.ts';
import { type ViewerFact, type ViewerFactInput, type ViewerFactsPage, type ViewerQuestion } from './viewer-facts.ts';
export type ViewerPersonalActionInput = ViewerFactInput & Readonly<{
    resourceType: string;
}>;
export type ViewerPersonalActionRuntime = Readonly<{
    access: Access;
    resources: ViewerActionResources;
    bindings: ViewerActionBindings;
    clock: () => Date;
}>;
export type ViewerPersonalAction = Readonly<{
    action: string;
    operations: readonly string[];
}>;
export type ViewerPersonalActionState = Readonly<{
    state: 'current';
    allowed: readonly ViewerPersonalAction[];
}> | Readonly<{
    state: 'unavailable';
    reason: 'admission' | 'currentness' | 'dependency';
}>;
export type ViewerPersonalFact = ViewerFact & Readonly<{
    actions: ViewerPersonalActionState;
}>;
export type ViewerPersonalActionsPage = Readonly<{
    state: 'current';
    question: ViewerQuestion | null;
    rows: readonly ViewerPersonalFact[];
}> | Extract<ViewerFactsPage, {
    state: 'unavailable';
}>;
export type ViewerPersonalActionsReader = (actor: Actor, rows: readonly ViewerPersonalActionInput[], questionId: string, deadline: number) => Promise<ViewerPersonalActionsPage>;
export type ViewerPersonalActionsDependencies = Readonly<{
    pool: Pool;
    viewerActionRuntime: () => ViewerPersonalActionRuntime;
}>;
/**
 * Compose exact Entry and standard-score facts with the current mounted Access actions.
 * Rows are already source-admitted by the caller; this helper preserves their original Subject IDs.
 */
export declare function readViewerPersonalActionsPage(dependencies: ViewerPersonalActionsDependencies, actor: Actor, inputRows: readonly ViewerPersonalActionInput[], questionId: string, deadline: number): Promise<ViewerPersonalActionsPage>;
