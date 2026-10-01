import { expect, test } from 'bun:test';
import { disclosureViewer, currentDisclosureViewer, withDisclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { eligible, ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { publicWorkRead } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const principal: VerifiedPrincipal = { issuer: 'account', subject: 'reader', contentEvidence: {
  age: 'adult', country: 'US', accountEligible: true, adultAvailable: true,
  categories: { general: true, r15: true, r18: false, r18g: false } } };
test('General, R15 and the two adult dimensions are independent; all public previews remain anonymous', () => {
  const viewer = disclosureViewer(principal);
  expect(eligible({ viewer, assessment: { status: 'assessed', labels: ['r15'] }, channel: 'read' }).eligible).toBe(true);
  expect(eligible({ viewer: { ...viewer, optIns: { ...viewer.optIns, general: false } },
    assessment: { status: 'assessed', labels: [] }, channel: 'read' }).reasons).toEqual(['general_disabled']);
  expect(eligible({ viewer: { ...viewer, optIns: { ...viewer.optIns, r15: false } },
    assessment: { status: 'assessed', labels: ['r15'] }, channel: 'read' }).reasons).toEqual(['r15_opt_in_required']);
  const sexual = { ...viewer, optIns: { ...viewer.optIns, sexual: true } };
  expect(eligible({ viewer: sexual, assessment: { status: 'assessed', labels: ['r18'] }, channel: 'read' }).eligible).toBe(true);
  expect(eligible({ viewer: sexual, assessment: { status: 'assessed', labels: ['r18', 'r18g'] }, channel: 'read' }).eligible).toBe(false);
  const both = { ...sexual, optIns: { ...sexual.optIns, grotesque: true } };
  expect(eligible({ viewer: both, assessment: { status: 'assessed', labels: ['r18', 'r18g'] }, channel: 'read' }).eligible).toBe(true);
  for (const channel of ['index', 'preview', 'email', 'push'] as const)
    expect(eligible({ viewer: both, assessment: { status: 'assessed', labels: ['r18'] }, channel }).eligible).toBe(false);
  const restrictedMarket = disclosureViewer({ ...principal, contentEvidence: {
    ...principal.contentEvidence!, adultAvailable: false, categories: { general: true, r15: true, r18: true, r18g: true } } });
  expect(restrictedMarket.optIns.sexual).toBe(false);
  expect(restrictedMarket.optIns.grotesque).toBe(false);
  expect(disclosureViewer(null)).toEqual(ANONYMOUS_VIEWER);
});
test('parallel request scopes isolate and restore their content evidence', async () => {
  const viewer = disclosureViewer(principal);
  const results = await Promise.all([withDisclosureViewer(viewer, async () => {
    await Promise.resolve(); return currentDisclosureViewer();
  }), withDisclosureViewer(ANONYMOUS_VIEWER, async () => {
    await Promise.resolve(); return currentDisclosureViewer();
  })]);
  expect(results).toEqual([viewer, ANONYMOUS_VIEWER]);
  expect(currentDisclosureViewer()).toEqual(ANONYMOUS_VIEWER);
});
test('a public read carries verified preferences without granting private inventory authority', async () => {
  let verifications = 0;
  const deps = { account: { verify: async () => { verifications++; return principal; } },
    environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
      fuseki: { query: async () => ({ results: { bindings: [{
        epoch: { value: 'epoch' }, sequence: { value: '1' } }] } }) } },
  } as unknown as MainWorkDependencies;
  const request = new Request('http://main/v1/works', { headers: { authorization: 'Bearer current-reader' } });
  const result = await publicWorkRead(deps, request, {}, async session => {
    expect(session.principal).toBeNull();
    expect(session.request.headers.has('authorization')).toBe(false);
    expect(currentDisclosureViewer()).toEqual(disclosureViewer(principal));
    return session.viewer;
  });
  expect(result).toEqual(disclosureViewer(principal));
  expect(verifications).toBe(1);
  expect(currentDisclosureViewer()).toEqual(ANONYMOUS_VIEWER);
  expect(await publicWorkRead(deps, new Request(request.url), {}, async session => session.viewer))
    .toEqual(ANONYMOUS_VIEWER);
});
