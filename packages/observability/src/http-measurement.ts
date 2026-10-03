/** Only the numeric Jena timer is retained; descriptions may contain query text. */
export function fusekiEngineTime(headers: Headers): number | undefined {
  const timing = headers.get('server-timing');
  const match = timing?.match(/(?:^|,)\s*jena\s*;\s*dur=(\d+(?:\.\d+)?)(?:\s*;[^,]*)?(?=,|$)/i);
  const value = match ? Number(match[1]) : undefined;
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Streams and FormData have no known encoded length without consuming them. */
export function requestBodyBytes(
  input: string | URL | Request,
  init?: RequestInit,
): number | undefined {
  const body = init?.body;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body === null || (!(input instanceof Request) && body === undefined)) return 0;
  if (input instanceof Request && !input.body && body === undefined) return 0;
  return undefined;
}

/** Replacing a body must retain fetch's URL/redirect/type semantics, including clones. */
export function preserveResponseMetadata(original: Response, observed: Response): Response {
  const clone = observed.clone.bind(observed);
  Object.defineProperties(observed, {
    url: { value: original.url },
    redirected: { value: original.redirected },
    type: { value: original.type },
    clone: { value: () => preserveResponseMetadata(original, clone()) },
  });
  return observed;
}
