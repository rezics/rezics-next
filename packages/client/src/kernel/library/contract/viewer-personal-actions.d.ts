import type { ViewerFact, ViewerFactsPage, ViewerFactInput, ViewerQuestion } from './viewer-facts.ts';
/** Serializable Library viewer facts and the current action advice attached to them. */
export type ViewerPersonalActionInput = ViewerFactInput & Readonly<{
    resourceType: string;
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
