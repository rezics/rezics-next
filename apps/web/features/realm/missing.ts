/** Proxy-owned refusal, stripped from incoming requests before it is carried to the page.
 * A Space address that resolves to nothing the reader may see — missing or private alike —
 * renders the same "isn't here" screen under a 404. */
export const SPACE_MISSING_HEADER = 'x-rezics-space-missing';
