import type { HistoryBarrier } from '../history/registry.ts';

/** Opaque source-local terminal proof. The producer intentionally exports no constructor. */
declare const subjectErasureSourceProof: unique symbol;
export type SubjectErasureSourceProof = { readonly [subjectErasureSourceProof]: true };
export type SubjectErasureSourceBarrier = HistoryBarrier;
