import { createHash } from 'node:crypto';
import { STAGE_LIMITS, STAGE_PROFILE, type ChangeStageRow, type ChangeStagePageRow,
  type ChangeStageValidationRow } from './stage-schema.ts';
import { checkedComponentState } from './change.ts';
import { checkedNativeIri } from './schema.ts';
import { modelGenerationHeadGuard } from './generation-guard.ts';

export const semanticStageCostContract = {
  variables: ['pages', 'items', 'pageBytes', 'totalBytes'],
  bound: 'Page normalization and digest work is O(items + totalBytes); activation checks O(pages) metadata before the guarded graph write.',
  limits: STAGE_LIMITS,
  retry: 'Page rows are immutable and unique by stage/ordinal; retries must present the same digest and count.',
} as const;

export interface SemanticStageItem {
  target?: string;
  expectedHead: string | null;
  state: unknown;
}

export interface PreparedSemanticStagePage {
  ordinal: number;
  bytes: Uint8Array;
  digest: string;
  itemCount: number;
}

export class SemanticStageRejected extends Error {
  constructor(readonly reason: 'unsupported' | 'too-large' | 'nonconforming' | 'generation-changed') {
    super(`semantic import stage is ${reason}`);
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Validate and canonicalize one bounded import page before Content owns its digest. */
export function prepareSemanticStagePage(ordinal: number, items: readonly SemanticStageItem[]): PreparedSemanticStagePage {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= STAGE_LIMITS.pages
    || !Array.isArray(items) || items.length < 1 || items.length > STAGE_LIMITS.itemsPerPage) {
    throw new SemanticStageRejected('too-large');
  }
  const targets = new Set<string>();
  const canonical = items.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key =>
      key !== 'target' && key !== 'expectedHead' && key !== 'state')
      || !Object.prototype.hasOwnProperty.call(item, 'expectedHead')) {
      throw new SemanticStageRejected('nonconforming');
    }
    try {
      if (item.target !== undefined) checkedNativeIri(item.target);
      if (item.expectedHead !== null) checkedNativeIri(item.expectedHead);
    } catch { throw new SemanticStageRejected('nonconforming'); }
    if ((item.target === undefined) !== (item.expectedHead === null)) {
      throw new SemanticStageRejected('nonconforming');
    }
    if (item.target) {
      if (targets.has(item.target)) throw new SemanticStageRejected('nonconforming');
      targets.add(item.target);
    }
    return { ...(item.target ? { target: item.target } : {}), expectedHead: item.expectedHead,
      state: checkedComponentState(item.state) };
  });
  const bytes = Buffer.from(JSON.stringify(stable({ profile: STAGE_PROFILE, items: canonical })));
  if (bytes.byteLength > STAGE_LIMITS.pageBytes) throw new SemanticStageRejected('too-large');
  return { ordinal, bytes, digest: sha256(bytes), itemCount: canonical.length };
}

/**
 * Prove that every staged page is complete under the exact Content-captured model
 * generation and that the same immutable revision is still the Main head. Call
 * immediately before activation; the writer must also include this head guard in
 * its TDB2 update WHERE so a race after this read cannot activate stale data.
 */
export function checkedStageActivationBasis(stage: ChangeStageRow, pages: readonly ChangeStagePageRow[],
  validations: readonly ChangeStageValidationRow[], activeGeneration: string): {
    generation: string; headGuard: string;
  } {
  if (stage.profile !== STAGE_PROFILE || stage.validation_posture !== 'reject') {
    throw new SemanticStageRejected('unsupported');
  }
  if (!/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(stage.model_generation)
    || activeGeneration !== stage.model_generation) {
    throw new SemanticStageRejected('generation-changed');
  }
  if (pages.length !== stage.page_count || pages.some((page, ordinal) => page.ordinal !== ordinal
    || !/^[0-9a-f]{64}$/.test(page.page_digest) || page.byte_size < 1 || page.byte_size > STAGE_LIMITS.pageBytes
    || page.item_count < 1 || page.item_count > STAGE_LIMITS.itemsPerPage)) {
    throw new SemanticStageRejected('nonconforming');
  }
  const conforming = new Set(validations.filter(validation => validation.model_generation === stage.model_generation
    && validation.outcome === 'conforming').map(validation => validation.ordinal));
  if (conforming.size !== stage.page_count || Array.from({ length: stage.page_count }, (_, ordinal) => ordinal)
    .some(ordinal => !conforming.has(ordinal))) {
    throw new SemanticStageRejected('nonconforming');
  }
  return { generation: stage.model_generation, headGuard: modelGenerationHeadGuard(stage.model_generation) };
}
