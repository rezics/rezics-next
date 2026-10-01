import type { MainClient } from './types.ts';

// Main's platform safety shapes (`services/main/src/routes/safety-cases.ts`,
// `routes/reports.ts`), taken from the typed Eden client so a contract change
// breaks this build. The UI shows what these routes return and decides nothing
// by itself.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Safety = MainClient['v1']['safety-cases'];
type SafetyCaseRoute = ReturnType<Safety>;

export type SafetyPage = Ok<Safety['get']>;
export type SafetyItem = SafetyPage['items'][number];
export type SafetyCase = Ok<SafetyCaseRoute['get']>;
export type SafetyDecisionInput = Parameters<SafetyCaseRoute['decisions']['post']>[0];
export type SafetyDecisionResult = Ok<SafetyCaseRoute['decisions']['post']>;
export type SafetyOutcome = SafetyDecisionInput['outcome'];
export type SafetyTarget = SafetyDecisionInput['targets'][number];
export type SafetyEffect = SafetyTarget['effect'];
export type SafetyReasons = NonNullable<SafetyDecisionInput['reasons']>;
export type SafetyClaim = Ok<SafetyCaseRoute['claim']['post']>;
export type ReportEvidence = Ok<ReturnType<MainClient['v1']['reports']>['get']>;
export type GovernanceRule = Ok<MainClient['v1']['governance']['rule-queries']['post']>;
