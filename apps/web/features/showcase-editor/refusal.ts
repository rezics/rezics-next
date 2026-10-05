// What a showcase save came to, typed by what a person can do about it. Main's problem codes
// (services/main/src/routes/media.ts `mediaError`, resources.ts showcase writes) carry the reason;
// this only sorts them so each gets its own words.

export type Refusal =
  | 'sign-in'
  /** No authority to select the Work's cover and showcase art. */
  | 'denied'
  /** The Work can't be read as this identity, or no longer exists. */
  | 'gone'
  /** Someone changed this selection since the person started: reload, never overwrite. */
  | 'conflict'
  | 'crop' | 'ratio' | 'resolution' | 'alpha' | 'trailer'
  /** The image is not usable by this identity: still in screening, held, or uploaded by someone else. */
  | 'missing'
  /** The same key was used for a different save. */
  | 'repeat'
  | 'limited'
  | 'invalid'
  | 'unavailable';

export type SaveResult =
  | { status: 'done'; selection: string; replayed: boolean }
  | { status: 'refused'; refusal: Refusal; code: string | null; detail: string | null;
    /** On a conflict, the selection Main holds now. */
    current: string | null; retryAfter?: number };

const byCode: Record<string, Refusal> = {
  showcase_crop_invalid: 'crop', showcase_ratio_mismatch: 'ratio', showcase_resolution_too_small: 'resolution',
  showcase_alpha_required: 'alpha', showcase_trailer_invalid: 'trailer', stale_head: 'conflict',
  idempotency_conflict: 'repeat', media_unavailable: 'missing', resource_unavailable: 'gone', authority_denied: 'denied',
};

/** The refusal a Main error answer means. */
export function refusalOf(error: { status: number; value?: unknown }, retryAfter: number | null = null): SaveResult {
  const value = typeof error.value === 'object' && error.value !== null ? error.value as Record<string, unknown> : {};
  const code = typeof value.code === 'string' ? value.code : null;
  const detail = typeof value.detail === 'string' && value.detail ? value.detail
    : typeof value.title === 'string' && value.title ? value.title : null;
  const current = typeof value.current === 'string' ? value.current : null;
  const refusal: Refusal = error.status === 401 ? 'sign-in'
    : error.status === 429 ? 'limited'
      : error.status === 503 && code === 'media_unavailable' ? 'unavailable'
        : (code ? byCode[code] : undefined) ?? (error.status === 403 ? 'denied' : error.status === 404 ? 'gone'
          : error.status === 400 || error.status === 422 ? 'invalid' : 'unavailable');
  return { status: 'refused', refusal, code, detail, current, ...(retryAfter ? { retryAfter } : {}) };
}
