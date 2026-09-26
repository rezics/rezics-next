import type { Pool } from 'pg';
import type { Corpus } from '../corpus.ts';

/**
 * One background-fixture generator per storage owner.
 *
 * A generator writes deterministic records for the corpus entities directly
 * into its owner's storage; it never calls public commands and never fabricates
 * interactive receipts. `summarize` and `load` must walk the same records in the
 * same order, so the manifest digest and counts describe exactly what `load`
 * wrote. Change `generator` whenever the stored records change for the same
 * corpus; a restore then rejects the stale backup instead of serving it.
 *
 * To add an owner (for example a new domain schema), export a `FixtureOwner`
 * from `scripts/fixture/owners/<owner>.ts` and append it to `fixtureOwners` in
 * `index.ts`. Keep cross-owner identities in `corpus.ts` so every owner agrees.
 */
export interface FixtureOwner {
  /** Manifest key. */
  readonly name: string;
  /** Record-shape version; any change invalidates retained backups of this owner. */
  readonly generator: string;
  /** `offline-graph` loads the stopped, bootstrapped TDB2; `online` runs with services up. */
  readonly phase: 'offline-graph' | 'online';
  /** Repository inputs whose change makes stored records of this owner stale. */
  compatibilityInputs(root: string): Record<string, string>;
  /** Deterministic digest and per-kind counts of the records `load` writes. */
  summarize(corpus: Corpus): OwnerSummary;
  load(corpus: Corpus, target: LoadTarget): Promise<OwnerLoadResult>;
  /** Exact post-load counts, compared with `summarize`; runs once at build time. */
  verify(corpus: Corpus, target: LoadTarget): Promise<Record<string, number>>;
}

export interface OwnerSummary { digest: string; counts: Record<string, number> }
export interface OwnerLoadResult { elapsedMs: number; detail?: Record<string, unknown> }

export interface LoadTarget {
  root: string;
  apps: Record<string, string>;
  pools: { access: Pool; content: Pool };
  /** Streams bytes into a one-shot container that shares the stopped Fuseki volume. */
  fusekiOffline(script: string, input?: AsyncIterable<string>): Promise<string>;
}
