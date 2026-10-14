import { BFF_PREFIX } from '../api/browser.ts';

export const RECIPE_FILE_MAX_BYTES = 256 * 1024;

export type RecipeImportFailure = 'conflict' | 'denied' | 'invalid' | 'stale' | 'too-large' | 'unavailable';

export class RecipeImportError extends Error {
  constructor(readonly failure: RecipeImportFailure, readonly detail: string | null = null) {
    super(detail ?? failure);
    this.name = 'RecipeImportError';
  }
}

export interface RecipeImportRequest {
  structure: string;
  expectedHead: string;
  actingSubject: string;
  idempotencyKey: string;
  file: File;
}

export interface RecipeFileImport {
  structure: string;
  revision: string;
  sourceObservation: string;
  residualDigest: string;
  replayed: boolean;
  receipts: string[];
}

export interface RecipeImportApi {
  importFile: (input: RecipeImportRequest) => Promise<RecipeFileImport>;
}

type ImportFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function problemCode(value: unknown): string | null {
  return record(value) && typeof value.code === 'string' ? value.code : null;
}

function problemMessage(value: unknown): string | null {
  if (!record(value)) return null;
  return typeof value.detail === 'string' && value.detail ? value.detail
    : typeof value.title === 'string' && value.title ? value.title : null;
}

function refusal(status: number, value: unknown): RecipeImportError {
  const code = problemCode(value);
  const detail = problemMessage(value);
  if (status === 413 || code === 'recipe_file_too_large') return new RecipeImportError('too-large', detail);
  if (status === 409 && (code?.startsWith('stale_')
    || (code === 'recipe_conflict' && /stale/i.test(detail ?? '')))) {
    return new RecipeImportError('stale', detail);
  }
  if (status === 409) return new RecipeImportError('conflict', detail);
  if (status === 401 || status === 403 || status === 404) return new RecipeImportError('denied', detail);
  if (status === 400 || status === 422) return new RecipeImportError('invalid', detail);
  return new RecipeImportError('unavailable', detail);
}

function imported(value: unknown, expectedStructure: string): value is RecipeFileImport {
  return record(value) && value.structure === expectedStructure && typeof value.revision === 'string'
    && typeof value.sourceObservation === 'string' && typeof value.residualDigest === 'string'
    && typeof value.replayed === 'boolean' && Array.isArray(value.receipts)
    && value.receipts.every(receipt => typeof receipt === 'string');
}

/** POSTs one local Schema.org document as the bounded raw body expected by Main. */
export function mainRecipeImportApi(options: {
  fetch?: ImportFetch; origin?: string; pageUrl?: string;
} = {}): RecipeImportApi {
  const send: ImportFetch = options.fetch ?? fetch;
  return {
    async importFile(input) {
      // File.size is available without reading the file, so an oversized file never leaves the browser.
      if (input.file.size > RECIPE_FILE_MAX_BYTES) throw new RecipeImportError('too-large');

      try {
        const origin = options.origin ?? (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
        const url = new URL(`${BFF_PREFIX}/v1/recipes/${encodeURIComponent(input.structure.slice(-36))}/file-imports`, origin);
        url.searchParams.set('actingSubject', input.actingSubject);
        url.searchParams.set('expectedHead', input.expectedHead);
        const pageUrl = options.pageUrl ?? (typeof window === 'undefined' ? null : window.location.href);
        const response = await send(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': input.file.type || 'application/json',
            'idempotency-key': input.idempotencyKey,
            ...(pageUrl ? { 'x-rezics-page-url': pageUrl } : {}),
          },
          body: input.file,
        });
        let answer: unknown = null;
        try { answer = await response.json(); } catch { /* A lost or malformed reply is safe to retry with this key. */ }
        if (!response.ok) throw refusal(response.status, answer);
        if (!imported(answer, input.structure)) throw new RecipeImportError('unavailable');
        return answer;
      } catch (error) {
        if (error instanceof RecipeImportError) throw error;
        throw new RecipeImportError('unavailable');
      }
    },
  };
}
