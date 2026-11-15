import type { Pool } from 'pg';
import type { SemanticTitleInputs } from '../contract/index.ts';
export type { SemanticTitleInputEntry, SemanticTitleInputs, SemanticTitleInputsObservation, } from '../contract/index.ts';
/** Bind Semantic's whole-source title observer to the native pool used by Content composition. */
export declare function createSemanticTitleInputsAdapter(pool: Pool): SemanticTitleInputs;
