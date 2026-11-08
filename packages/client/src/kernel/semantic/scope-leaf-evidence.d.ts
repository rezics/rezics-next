import type { ScopeEvidenceReader } from './contract/index.ts';
import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { FactClause } from '../search/disclosure/check.ts';
import type { IndexedStatement } from '../search/source.ts';
import { type ScopeWorkContext } from '../search/scope-work-context.ts';
export { createNativeKindTypeEvidence } from './kind-type-evidence.ts';
export type { NativeKindTypeEvidence, KindTypeEvidenceReference, KindTypeEvidenceProgress, KindTypeEvidenceAudienceInput, KindTypeEvidenceReadInput, KindTypeEvidenceReadResult, KindTypeEvidenceVerifyInput, KindTypeEvidenceVerifyResult, } from './kind-type-evidence.ts';
export type LeafWork = Readonly<{
    keys: number;
    points: number;
    witnesses: number;
    rows: number;
    bytes: number;
    emptySeeks: number;
}>;
export type LeafProgress = Readonly<{
    basis: string;
    phase: 'compact' | 'selection' | 'witness';
    valueOrdinal: number;
    after: string | null;
}>;
export type SelectedLeafFact = Readonly<{
    witness: string;
    statement: IndexedStatement;
    release: string;
    revision: number;
    rank: 'normal' | 'preferred';
}>;
export type LeafCoverage = {
    kind: 'selection';
    basis: string;
} | {
    kind: 'empty_pair';
    basis: string;
};
export type LeafEvidence = {
    state: 'basis_changed' | 'not_ready';
    usage: LeafWork;
} | {
    state: 'current';
    basis: string;
    type: string | null;
    facts: readonly SelectedLeafFact[];
    coverage: LeafCoverage | null;
    progress: LeafProgress | null;
    usage: LeafWork;
};
export type LeafRequest = Readonly<{
    subject: string;
    leaf: FactClause;
    after: LeafProgress | null;
    /** One opaque witness identity for revalidation, not a receipt or permission; exclusive with `after`. */
    revalidate: string | null;
    budget: LeafWork;
}>;
export type LeafOptions = ScopeEvidenceReader<Access, Actor, AuthoritativeTime, ScopeWorkContext>;
export type LeafReader = (pool: Pool, request: LeafRequest, options: LeafOptions) => Promise<LeafEvidence>;
/** Native selected evidence only; matching remains the shared Search pure matcher. */
export declare function readScopeLeafEvidence(pool: Pool, request: LeafRequest, options: LeafOptions): Promise<LeafEvidence>;
