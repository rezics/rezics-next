/** Follow the authorized discovery contract used by a client preparing a write. */
export async function workAuthorityEpoch(app: { handle(request: Request): Response | Promise<Response> },
  token: string): Promise<string> {
  const response = await app.handle(new Request('http://main.local/v1/me/acting-contexts?task=work.create',
    { headers: { authorization: `Bearer ${token}` } }));
  const body = await response.json() as { authorityEpoch?: string };
  if (response.status !== 200 || typeof body.authorityEpoch !== 'string') {
    throw new Error(`Authority discovery failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.authorityEpoch;
}

export async function groupGeneration(app: { handle(request: Request): Response | Promise<Response> },
  token: string, issuerSubject: string): Promise<string> {
  const response = await app.handle(new Request('http://main.local/v1/access/group-scope?issuerSubject='
    + encodeURIComponent(issuerSubject), { headers: { authorization: `Bearer ${token}` } }));
  const body = await response.json() as { groupGeneration?: string };
  if (response.status !== 200 || typeof body.groupGeneration !== 'string') {
    throw new Error(`Group discovery failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.groupGeneration;
}

export async function authorityState(app: { handle(request: Request): Response | Promise<Response> },
  token: string, scopeId: string, actingSubject: string, action: string) {
  const query = new URLSearchParams({ scopeId, actingSubject, action });
  const response = await app.handle(new Request(`http://main.local/v1/access/authority-state?${query}`,
    { headers: { authorization: `Bearer ${token}` } }));
  const body = await response.json() as { authorityEpoch: string; representation: { id: string; generation: string } };
  if (response.status !== 200) throw new Error(`Authority read failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

export async function revocationSourceState(app: { handle(request: Request): Response | Promise<Response> },
  token: string, sourceId: string, issuerSubject: string) {
  const response = await app.handle(new Request(`http://main.local/v1/access/revocation-sources/${sourceId}?`
    + new URLSearchParams({ issuerSubject }), { headers: { authorization: `Bearer ${token}` } }));
  const body = await response.json() as { authorityEpoch: string; source: { id: string; generation: string } };
  if (response.status !== 200) throw new Error(`Revocation source read failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

/** Fixtures remember identities they created; all mutable request preconditions
 * still come from HTTP. A previously observed revision remains useful for denied
 * and recovery-held calls, where a client cannot refresh its snapshot. */
export class AuthorityValues {
  private readonly users = new Map<string, { token: string; scope: string }>();
  private readonly mandates: { principalId: string; subject: string; action: string }[] = [];
  private readonly epochs = new Map<string, string>();
  constructor(private readonly app: { handle(request: Request): Response | Promise<Response> }) {}
  user(principalId: string, token: string, scope: string) { this.users.set(principalId, { token, scope }); }
  mandate(principalId: string, subject: string, action: string) { this.mandates.push({ principalId, subject, action }); }
  created(token: string, subject: string) {
    const principalId = [...this.users].find(([, user]) => user.token === token)?.[0];
    if (principalId) this.mandate(principalId, subject, 'agent.control');
  }
  async epoch(scope = 'work:create:root'): Promise<string> {
    let failure: unknown;
    if (scope === 'work:create:root') {
      for (const user of this.users.values()) {
        if (!user.scope.split(' ').includes('work:create')) continue;
        try {
          const epoch = await workAuthorityEpoch(this.app, user.token);
          this.epochs.set(scope, epoch);
          return epoch;
        } catch (error) { failure = error; }
      }
    } else {
      const action = scope === 'access:representation-topology' ? 'access.representation.manage' : 'agent.control';
      for (const mandate of this.mandates) {
        if (mandate.action !== action) continue;
        const user = this.users.get(mandate.principalId);
        if (!user) continue;
        try {
          const epoch = (await authorityState(this.app, user.token, scope, mandate.subject, action)).authorityEpoch;
          this.epochs.set(scope, epoch);
          return epoch;
        } catch (error) { failure = error; }
      }
    }
    const observed = this.epochs.get(scope);
    if (observed !== undefined) return observed;
    throw failure ?? new Error(`No authorized API reader for ${scope}`);
  }
}
