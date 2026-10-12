const jsonAuthenticationPaths = new Set([
  '/api/auth/sign-in/email', '/api/auth/request-password-reset', '/api/auth/reset-password',
  '/api/auth/passkey/verify-authentication', '/api/auth/passkey/verify-registration',
]);

/** Refuse provider forms before selecting a lock, activity or budget owner.
 * OAuth token and introspection forms retain their provider contract. */
export async function authenticationMediaTypeFailure(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || (!jsonAuthenticationPaths.has(path)
    && !path.startsWith('/api/auth/two-factor/verify-'))) return null;
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return Response.json({ error: 'unsupported_media_type' },
    { status: 415, headers: { 'cache-control': 'no-store' } });
  try { await authenticationBody(request); return null; }
  catch { return Response.json({ error: 'invalid_request' },
    { status: 400, headers: { 'cache-control': 'no-store' } }); }
}

const bodies = new WeakMap<Request, Record<string, unknown>>();

/** Parse before selecting any lock or limiter owner. Duplicate keys must not
 * disappear at the provider boundary, including escaped keys and response.id. */
export async function authenticationBody(request: Request): Promise<Record<string, unknown>> {
  const cached = bodies.get(request);
  if (cached) return cached;
  const text = await request.clone().text();
  let at = 0;
  const invalid = (): never => { throw new Error('invalid authentication JSON'); };
  const space = () => { while (/[\t\r\n ]/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string => {
    if (text[at++] !== '"') return invalid();
    let result = '';
    while (at < text.length) {
      const char = text[at++]!;
      if (char === '"') return result;
      if (char.charCodeAt(0) < 32) return invalid();
      if (char !== '\\') { result += char; continue; }
      const escape = text[at++];
      if (escape === 'u') {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return invalid();
        result += String.fromCharCode(Number.parseInt(hex, 16));
        at += 4;
      } else {
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/',
          b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (escape === undefined || !Object.hasOwn(escapes, escape)) return invalid();
        result += escapes[escape];
      }
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) return invalid();
    space();
    if (text[at] === '"') return string();
    const open = text[at];
    if (open === '{' || open === '[') {
      at++;
      const end = open === '{' ? '}' : ']';
      const fields = Object.create(null) as Record<string, unknown>;
      const items: unknown[] = [];
      const seen = new Set<string>();
      space();
      if (text[at] === end) { at++; return open === '{' ? fields : items; }
      for (;;) {
        space();
        if (open === '{') {
          const key = string();
          const canonical = key.trim().toLowerCase();
          if (seen.has(canonical) || (['email', 'token', 'response', 'id'].includes(canonical)
            && key !== canonical)) return invalid();
          seen.add(canonical);
          space();
          if (text[at++] !== ':') return invalid();
          fields[key] = value(depth + 1);
        } else items.push(value(depth + 1));
        space();
        if (text[at] === end) { at++; return open === '{' ? fields : items; }
        if (text[at++] !== ',') return invalid();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at))?.[0];
    if (!token) return invalid();
    at += token.length;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const number = Number(token);
    return Number.isFinite(number) ? number : invalid();
  };
  const parsed = value(0);
  space();
  if (at !== text.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
  const body = parsed as Record<string, unknown>;
  bodies.set(request, body);
  return body;
}
