import { expect, test } from 'bun:test';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { GovernanceUnavailable } from '../src/modules/governance/store.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { withStructuredPublicationPreflight } from '../src/routes/publication.ts';

const workId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const parent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const components = ['publication', 'structure', 'record'] as const;

function fixture(options: {
  blocked?: { resource: string; component: string };
  error?: Error;
  fullPage?: boolean;
} = {}) {
  const events: string[] = [];
  const work = {
    environment: { fuseki: { query: async () => ({ results: { bindings: [{ parent: { value: parent } }] } }) } },
    governance: { store: { readEnforcement: async (target: { resource: string; component: string }) => {
      events.push(`read:${target.resource}:${target.component}`);
      if (options.error) throw options.error;
      if (options.fullPage) return Array.from({ length: 50 }, () => ({ effect: 'disclosure', state: 'released' }));
      return options.blocked?.resource === target.resource && options.blocked.component === target.component
        ? [{ effect: 'publication', state: 'restricted' }] : [];
    } } },
  } as unknown as MainWorkDependencies;
  return { work, events };
}

test('publication preflight checks Work and parent governance before native dispatch', async () => {
  const { work, events } = fixture({ blocked: { resource: parent, component: 'structure' } });
  const result = await withStructuredPublicationPreflight(work, workId, async allowed => {
    events.push(`dispatch:${allowed}`);
    return allowed;
  });

  expect(result).toBe(false);
  expect(events).toEqual([
    ...[workId, parent].flatMap(resource => components.map(component => `read:${resource}:${component}`)),
    'dispatch:false',
  ]);
});

test('publication preflight refuses an unavailable or truncated governance read', async () => {
  for (const options of [{ error: new GovernanceUnavailable('offline') }, { fullPage: true }]) {
    const { work, events } = fixture(options);
    let dispatched = false;
    await expect(withStructuredPublicationPreflight(work, workId, async () => {
      dispatched = true;
      return true;
    })).rejects.toBeInstanceOf(AdmissionUnavailable);
    expect(dispatched).toBe(false);
    expect(events).toHaveLength(6);
  }
});
