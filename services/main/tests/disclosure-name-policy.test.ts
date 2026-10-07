import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { PersonPreferencesStore } from '../src/modules/preferences/store.ts';
import { checkNamePolicy, NAME_POLICY_COST } from '../src/modules/disclosure/name-policy.ts';
import {
  DisclosureStore,
  configureDisclosure,
  DISCLOSURE_CHANNELS,
  discloseInventory,
  type DisclosureTarget,
} from '../src/modules/disclosure/read.ts';
import { disclosureViewer, withDisclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { discloseSearchMatches } from '../src/modules/disclosure/search.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { issuer: 'account', subject: 'controller' };
function fixture() {
  let queries = 0,
    failed = false,
    open = true,
    malformed = false;
  const owners = new Map<string, { public: boolean; active: boolean; controller?: string }>([
    [id(1), { public: false, active: true, controller: principal.subject }],
    [id(2), { public: true, active: true }],
    [id(3), { public: true, active: false }],
  ]);
  const visible = (agent: string, issuer: unknown, subject: unknown) =>
    !!owners.get(agent)?.active &&
    (owners.get(agent)!.public ||
      (issuer === principal.issuer && subject === owners.get(agent)!.controller));
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes('SELECT id AS agent'))
        return {
          rows: (args[0] as string[])
            .filter((agent) => owners.has(agent))
            .map((agent) => ({ agent })),
        };
      if (sql.includes('requested AS')) {
        expect(sql).toContain('name_policy AS MATERIALIZED');
        expect(sql).toContain('LEFT JOIN name_policy n');
        return {
          rows: (JSON.parse(String(args[0])) as { ordinal: number; nameOwner?: string }[]).map(
            (row) => ({
              ...row,
              open,
              restricted: false,
              assessments: [],
              nameVisible: !row.nameOwner || visible(row.nameOwner, args[4], args[5]),
            }),
          ),
        };
      }
      queries++;
      expect(sql).toContain('WITH fence AS MATERIALIZED');
      expect(sql).toContain('p.agent_id = s.id');
      expect(sql).toContain("r.action = 'agent.control'");
      expect(sql).toContain("a.state = 'active'");
      if (failed) throw new Error('offline');
      const requested = args[0] as string[];
      expect(requested.length).toBeLessThanOrEqual(NAME_POLICY_COST.owners);
      expect(new Set(requested).size).toBe(requested.length);
      return {
        rows: malformed
          ? []
          : requested.map((agent) => ({
              agent,
              open,
              visible: visible(agent, args[1], args[2]),
            })),
      };
    },
  } as unknown as Pool;
  return {
    pool,
    owners,
    preferences: new PersonPreferencesStore(pool),
    queries: () => queries,
    fail: () => {
      failed = true;
    },
    hold: () => {
      open = false;
    },
    corrupt: () => {
      malformed = true;
    },
  };
}

test('Name policy withholds private, inactive, unknown and invalid owners, but admits public and current controllers', async () => {
  const f = fixture(),
    names = [id(1), id(2), id(3), id(4), 'unknown'];
  expect(await checkNamePolicy(f.preferences, names, ANONYMOUS_VIEWER)).toEqual([
    'withheld',
    'visible',
    'withheld',
    'withheld',
    'withheld',
  ]);
  expect(await checkNamePolicy(f.preferences, names, disclosureViewer(principal))).toEqual([
    'visible',
    'visible',
    'withheld',
    'withheld',
    'withheld',
  ]);
  expect(
    (
      await checkNamePolicy(
        f.preferences,
        [id(1)],
        disclosureViewer({ ...principal, subject: 'stranger' }),
      )
    )[0],
  ).toBe('withheld');
  // Copying serialized preferences loses the trusted Account/Access audience.
  expect(await checkNamePolicy(f.preferences, [id(1)], { ...disclosureViewer(principal) })).toEqual(
    ['withheld'],
  );
});

test('Name policy keeps private names out of public discovery even for their controller', async () => {
  const f = fixture(),
    viewer = disclosureViewer(principal);
  for (const channel of ['search', 'typeahead', 'count', 'sitemap', 'seo', 'preview'] as const)
    expect(await checkNamePolicy(f.preferences, [id(1)], viewer, channel)).toEqual(['withheld']);
  for (const channel of ['read', 'summary', 'export'] as const)
    expect(await checkNamePolicy(f.preferences, [id(1)], viewer, channel)).toEqual(['visible']);
});

test('Name policy failures, recovery holds and incomplete results withhold every requested name', async () => {
  for (const state of ['fail', 'hold', 'corrupt'] as const) {
    const f = fixture();
    f[state]();
    expect(
      await checkNamePolicy(f.preferences, [id(1), id(2)], disclosureViewer(principal)),
    ).toEqual(['withheld', 'withheld']);
  }
});

test('Name policy batches one preference read per distinct owner and never caches revocation or restoration', async () => {
  const f = fixture(),
    viewer = disclosureViewer(principal);
  expect(await checkNamePolicy(f.preferences, [], viewer)).toEqual([]);
  expect(f.queries()).toBe(0);
  const owners = Array.from({ length: 64 }, (_, index) => id((index % 2) + 1));
  expect(await checkNamePolicy(f.preferences, owners, ANONYMOUS_VIEWER)).toEqual(
    owners.map((owner) => (owner === id(1) ? 'withheld' : 'visible')),
  );
  expect(f.queries()).toBe(1);
  await expect(checkNamePolicy(f.preferences, [...owners, id(2)], viewer)).rejects.toThrow('bound');
  expect(f.queries()).toBe(1);
  f.owners.get(id(1))!.public = true;
  expect(await checkNamePolicy(f.preferences, [id(1)], ANONYMOUS_VIEWER)).toEqual(['visible']);
  f.owners.get(id(1))!.public = false;
  f.owners.get(id(1))!.controller = undefined;
  expect(await checkNamePolicy(f.preferences, [id(1)], viewer)).toEqual(['withheld']);
  expect(f.queries()).toBe(3);
});

test('Name policy costs one preference statement for a full page of 64 distinct owners', async () => {
  const f = fixture(),
    owners = Array.from({ length: 64 }, (_, index) => id(index + 1));
  owners.forEach((owner, index) => f.owners.set(owner, { active: true, public: index % 2 === 0 }));
  expect(await checkNamePolicy(f.preferences, owners, ANONYMOUS_VIEWER)).toEqual(
    owners.map((_, index) => (index % 2 === 0 ? 'visible' : 'withheld')),
  );
  expect(f.queries()).toBe(1);
});

test('Pool-only disclosure readers enforce private names and withhold unknown occurrence owners', async () => {
  const f = fixture(),
    reader = new DisclosureStore(f.pool);
  const target: DisclosureTarget = { owner: 'graph', resource: id(1), component: 'name' };
  expect(await reader.read([target], ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);
  expect(await reader.read([target], disclosureViewer(principal), 'read')).toEqual(['visible']);
  expect(
    await reader.read(
      [{ ...target, resource: id(10), nameOwner: id(4) }],
      ANONYMOUS_VIEWER,
      'summary',
    ),
  ).toEqual(['hidden']);
});

test('Disclosure applies Agent name policy on every channel without changing Work read authority', async () => {
  const f = fixture(),
    graph = new FusekiClient('http://graph.invalid');
  graph.query = async (query) => {
    expect(query).not.toMatch(/\*|\+/);
    const refs = [
      ...(/VALUES \?work \{([^}]+)\}/.exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g),
    ].map((match) => match[1]!);
    return {
      results: {
        bindings: refs.map((work) => ({
          work: { type: 'uri', value: work },
          head: { type: 'uri', value: id(70) },
          ...(work === id(1) ? { nameOwner: { type: 'uri', value: work } } : {}),
        })),
      },
    };
  };
  const env = {
    fuseki: graph,
    objectDirectory: '.temp/name-policy',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
  };
  configureDisclosure(env, new DisclosureStore(f.pool));
  const targets: DisclosureTarget[] = [
    { owner: 'graph', resource: id(1), component: 'name' },
    { owner: 'graph', resource: id(10), work: id(10), component: 'name' },
    { owner: 'content', resource: id(10), work: id(10), component: 'body' },
  ];
  for (const channel of DISCLOSURE_CHANNELS)
    expect(await discloseInventory(env, targets, ANONYMOUS_VIEWER, channel)).toEqual([
      'hidden',
      'visible',
      'visible',
    ]);
  expect(await discloseInventory(env, targets, disclosureViewer(principal), 'summary')).toEqual([
    'visible',
    'visible',
    'visible',
  ]);
  // Credited-name owners can differ from the readable resource carrying them.
  expect(
    await discloseInventory(
      env,
      [{ ...targets[1]!, nameOwner: id(1) }],
      ANONYMOUS_VIEWER,
      'summary',
    ),
  ).toEqual(['hidden']);
  expect(
    await withDisclosureViewer(disclosureViewer(principal), () =>
      discloseSearchMatches(env, [{ work: id(10), nameOwner: id(1), matchedField: 'credit' }]),
    ),
  ).toEqual([]);
});
