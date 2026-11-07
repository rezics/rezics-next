import type { KeyRing } from '../tokens/seal.ts';
import { ProblemError } from '../http/problem-error.ts';
import { bindSearchIdentityCursorRequest } from './canonical-keyset.ts';
import { decodeSearchCursor, encodeSearchCursor, type SearchCursorBinding } from './cursor.ts';
import type { ScopeBasis } from './scope-source.ts';
import type { AdmittedSearchRequest, ExecutedSearchRequest } from './service-contract.ts';

/** Bind the Scope's immutable source basis to the already admitted request identity. */
export function bindSearchScopeCursorRequest(request: unknown, basis: ScopeBasis): unknown {
  const record =
    request !== null && typeof request === 'object' && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : { request };
  return {
    ...record,
    scopeBasis: {
      release: basis.release,
      query: basis.query,
      profile: basis.profile,
      canonical: basis.canonical,
      generation: 'generation' in basis ? basis.generation : null,
      index: 'index' in basis ? basis.index : null,
    },
  };
}

export function scopeCursorAfter(sort: 'id', after: readonly (string | number | null)[]): string;
export function scopeCursorAfter(
  sort: 'name',
  after: readonly (string | number | null)[],
): readonly [string | null, string];
export function scopeCursorAfter(
  sort: 'collections',
  after: readonly (string | number | null)[],
): readonly [number, string | null, string];
export function scopeCursorAfter(
  sort: 'id' | 'name' | 'collections',
  after: readonly (string | number | null)[],
): string | readonly [string | null, string] | readonly [number, string | null, string] {
  if (sort === 'id') {
    if (after.length !== 1 || typeof after[0] !== 'string') throw new ProblemError('search_restart_required');
    return after[0];
  }
  if (sort === 'name') {
    if (after.length !== 2 || !(after[0] === null || typeof after[0] === 'string') || typeof after[1] !== 'string')
      throw new ProblemError('search_restart_required');
    return [after[0], after[1]] as const;
  }
  if (
    after.length !== 3 ||
    typeof after[0] !== 'number' ||
    !(after[1] === null || typeof after[1] === 'string') ||
    typeof after[2] !== 'string'
  )
    throw new ProblemError('search_restart_required');
  return [after[0], after[1], after[2]] as const;
}

const bindingFor = (binding: SearchCursorBinding) => ({ ...binding, operation: 'subjects.search.kinds' });

export function encodeKindCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  generation: number,
  digest: string,
  after: string,
  now: number,
) {
  return encodeSearchCursor(ring, bindingFor(binding), { generation, after: [digest, after] }, now);
}

export async function decodeKindCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  token: string,
  generation: number,
  digest: string,
  now: number,
): Promise<string> {
  const decoded = await decodeSearchCursor(ring, bindingFor(binding), token, now);
  if (!decoded.ok) {
    if (decoded.reason === 'expired') throw new ProblemError('search_restart_required');
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/kindCursor', code: 'invalid_format' }] });
  }
  if (decoded.generation !== generation || decoded.after[0] !== digest)
    throw new ProblemError('search_restart_required');
  if (decoded.after.length !== 2 || typeof decoded.after[1] !== 'string')
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/kindCursor', code: 'invalid_format' }] });
  return decoded.after[1];
}

export type SearchCursorPlanner = Readonly<{
  bindExecutionRequest: (admission: AdmittedSearchRequest, identityEpoch: string) => ExecutedSearchRequest;
  bindScopeRequest: (request: ExecutedSearchRequest, basis: ScopeBasis) => unknown;
  scopeAfter: typeof scopeCursorAfter;
  encodeKind: typeof encodeKindCursor;
  decodeKind: typeof decodeKindCursor;
}>;

/** Build one post-admission request object and use it for every cursor binding in the execution. */
export function createSearchCursorPlanner(): SearchCursorPlanner {
  return Object.freeze({
    bindExecutionRequest(admission: AdmittedSearchRequest, identityEpoch: string) {
      return {
        admission,
        identityEpoch,
        bindingRequest: bindSearchIdentityCursorRequest(admission.bindingRequest, identityEpoch),
      };
    },
    bindScopeRequest(request: ExecutedSearchRequest, basis: ScopeBasis) {
      return bindSearchScopeCursorRequest(request.bindingRequest, basis);
    },
    scopeAfter: scopeCursorAfter,
    encodeKind: encodeKindCursor,
    decodeKind: decodeKindCursor,
  });
}
