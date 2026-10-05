import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AdmissionDenied, AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { AccountAssertionDenied, AccountAssertionInsufficientScope, AccountAssertionUnavailable }
  from '../src/modules/account/verify-assertion.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { zoneRoutes } from '../src/routes/zones.ts';

function fixture(input: { verificationError?: Error; authorityError?: Error; missingAuthority?: boolean } = {}) {
  const zone = `https://rezics.com/id/${randomUUID()}`;
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const principal = { issuer: 'https://account.local', subject: 'reader' };
  const probes = { authentication: 0, authority: 0, graph: 0 };
  const fuseki = { query: async (query: string) => {
    probes.graph++;
    return query.includes('ASK') ? { boolean: true } : { results: { bindings: [] } };
  } } as unknown as FusekiClient;
  const work = { environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: '1' } },
    account: { verify: async (_request: Request, scopes: string[]) => {
      probes.authentication++;
      expect(scopes).toEqual(['zone:edit']);
      if (input.verificationError) throw input.verificationError;
      return principal;
    } }, access: { ...(input.missingAuthority ? {} : {
      assertAuthority: async (request: unknown) => {
        probes.authority++;
        expect(request).toEqual({ principal, actingSubject: actor, scope: `zone:edit:${zone}`, action: 'zone.edit' });
        if (input.authorityError) throw input.authorityError;
      },
    }) } } as unknown as MainWorkDependencies;
  const app = zoneRoutes(fuseki, work);
  return { probes, read: (endpoint: string) => app.handle(new Request(
    `http://main.local/v1/zones/${zone.slice(-36)}/${endpoint}?actingSubject=${encodeURIComponent(actor)}`,
    { headers: { authorization: 'Bearer reader' } },
  )) };
}

for (const endpoint of ['configuration', 'showcase-editor']) {
  test(`Zone ${endpoint} hides authority denial with the missing configuration problem before owner IO`, async () => {
    const missing = fixture();
    const missingResponse = await missing.read(endpoint);
    expect(missingResponse.status).toBe(404);
    expect(missing.probes).toEqual({ authentication: 1, authority: 1, graph: 2 });
    const denied = fixture({ authorityError: new AdmissionDenied('Reader cannot edit this Zone') });
    const deniedResponse = await denied.read(endpoint);
    expect(deniedResponse.status).toBe(404);
    expect(await deniedResponse.json()).toEqual(await missingResponse.json());
    expect(denied.probes).toEqual({ authentication: 1, authority: 1, graph: 0 });
  });

  test(`Zone ${endpoint} hides missing editor scope and fails closed without an authority probe`, async () => {
    for (const input of [
      { verificationError: new AccountAssertionInsufficientScope('No zone:edit consent') },
      { missingAuthority: true },
    ]) {
      const f = fixture(input);
      const response = await f.read(endpoint);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'zone_unavailable', title: 'Zone is unavailable' });
      expect(f.probes).toEqual({ authentication: 1, authority: 0, graph: 0 });
    }
  });

  test(`Zone ${endpoint} preserves authentication and unavailable-service outcomes before owner IO`, async () => {
    for (const [input, status, authority] of [
      [{ verificationError: new AccountAssertionDenied('Invalid credentials') }, 401, 0],
      [{ verificationError: new AccountAssertionUnavailable('Account unavailable') }, 503, 0],
      [{ authorityError: new AdmissionUnavailable('Access unavailable') }, 503, 1],
    ] as const) {
      const f = fixture(input);
      const response = await f.read(endpoint);
      expect(response.status).toBe(status);
      expect(f.probes).toEqual({ authentication: 1, authority, graph: 0 });
    }
  });
}
