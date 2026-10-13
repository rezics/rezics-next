import { expect, test } from 'bun:test';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { progressRoutes } from '../src/routes/progress.ts';

const uuid = '00000000-0000-4000-8000-000000000001';
const person = `https://rezics.com/id/${uuid}`;
const principal: VerifiedPrincipal = { issuer: 'account', subject: 'reader', emailVerified: true };
const operations = [
  { method: 'GET', path: `/v1/compositions/${uuid}/progress` },
  { method: 'GET', path: `/v1/compositions/${uuid}/occurrences/${uuid}/progress` },
  { method: 'PUT', path: `/v1/compositions/${uuid}/occurrences/${uuid}/progress`,
    body: { expectedVersion: 0, completed: true, position: null } },
  { method: 'GET', path: `/v1/works/${uuid}/progress` },
  { method: 'PUT', path: `/v1/works/${uuid}/progress`,
    body: { expectedVersion: 0, standing: 'completed' } },
] as const;

for (const operation of operations) {
  for (const baseline of ['denied', 'unavailable'] as const) {
    test(`${operation.method} ${operation.path}: ${baseline} Person control refuses before private state`, async () => {
      const scopes: (readonly string[])[] = [];
      const decisions: { principal: VerifiedPrincipal; agent: string }[] = [];
      const privateCalls: string[] = [];
      const fuseki = { query: async () => ({ boolean: true, results: { bindings: [] } }) } as unknown as FusekiClient;
      const work = {
        environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
        account: { verify: async (_request: Request, required: readonly string[]) => {
          scopes.push(required);
          return principal;
        } },
        access: {
          assertRecoveryOpen: async () => {},
          // Public visibility or other roles cannot substitute for Person control.
          canReadWork: async () => true,
          ...(baseline === 'denied' ? { canReadAsBaselineMember: async (caller: VerifiedPrincipal, agent: string) => {
            decisions.push({ principal: caller, agent });
            return false;
          } } : {}),
        },
        progress: {
          read: async () => { privateCalls.push('read'); },
          completedPage: async () => { privateCalls.push('completedPage'); },
          write: async () => { privateCalls.push('write'); },
        },
      } as unknown as MainWorkDependencies;
      const app = progressRoutes(fuseki, work);
      const write = operation.method === 'PUT';
      const response = await app.handle(new Request(`http://localhost${operation.path}${write
        ? '' : `?actingSubject=${encodeURIComponent(person)}`}`, {
        method: operation.method,
        headers: { 'content-type': 'application/json', 'idempotency-key': 'authority-test' },
        ...(write && 'body' in operation ? { body: JSON.stringify({ actingSubject: person, ...operation.body }) } : {}),
      }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'authority_denied' });
      expect(scopes).toEqual([write ? ['work:read', 'library:write'] : ['work:read']]);
      expect(decisions).toEqual(baseline === 'denied' ? [{ principal, agent: person }] : []);
      expect(privateCalls).toEqual([]);
    });
  }
}
