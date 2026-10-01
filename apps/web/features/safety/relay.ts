// The report page's relay carries one credential header Main reads on exactly
// two routes. Everything else a browser might ask it for is refused, so the
// relay cannot be used as a second general BFF.

export const CASE_CREDENTIAL_HEADER = 'x-rezics-case-credential';
const CASE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const status = new RegExp(`^v1/public-reports/${CASE}$`);
const correspondence = new RegExp(`^v1/public-reports/${CASE}/correspondence$`);

/** Whether the relay serves `method` on this Main path (`v1/public-reports/<case>[/correspondence]`). */
export function relays(path: readonly string[], method: string): boolean {
  const joined = path.join('/');
  return method === 'GET' ? status.test(joined) : method === 'POST' && correspondence.test(joined);
}

/** Adds the credential to the call that reaches Main, and to no other call the BFF makes on the way. */
export function withCredential(credential: string, send: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.startsWith('/v1/public-reports/') || !credential) return send(input, init);
    const headers = new Headers(init?.headers);
    headers.set(CASE_CREDENTIAL_HEADER, credential);
    return send(input, { ...init, headers });
  }) as typeof fetch;
}
