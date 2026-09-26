import type { TestResult } from '../acceptance.ts';

export type TestIdentity = Pick<TestResult, 'tier' | 'file' | 'name'>;

/** Complete-case declarations owned by one acceptance ID prefix. */
export type CaseDeclarations = Readonly<Record<string, readonly TestIdentity[]>>;
