import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { CommandEnvelope, SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { ReadingPositionTraversal } from '../../../services/main/src/modules/reading-position/traversal.ts';
import type { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { RV, prepareComponent, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { readWorkComponentState } from '../../../services/main/src/modules/work/history.ts';
import { createAdmittedOwner } from '../../../services/main/src/modules/zone/owner-create.ts';
import { changeZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE, ZONE_LIMITS } from '../../../services/main/src/modules/zone/config-format.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(1), space = id(2), structure = id(3), revision = id(4), actor = id(5), zone = id(6);
const binding = (value: string) => ({ type: 'literal' as const, value });
const rows = (bindings: NonNullable<SparqlResult['results']>['bindings']) => ({ results: { bindings } });

/** GRAPH is a nested filter scope, including the braces of NOT EXISTS. */
function graphGroups(query: string) {
  const groups: string[] = [];
  for (const start of query.matchAll(/GRAPH <[^>]+> \{/g)) {
    let depth = 1, end = start.index! + start[0].length;
    const body = end;
    while (depth && end < query.length) {
      if (query[end] === '{') depth++;
      if (query[end] === '}') depth--;
      end++;
    }
    expect(depth).toBe(0);
    groups.push(query.slice(body, end - 1));
  }
  return groups;
}

test('G-974/G954: ordinal comparisons join VALUES keys before filtering graph counts and remain private', async () => {
  const occurrences = [id(10), id(11), id(12)];
  const ordinals = [1, 2, 1000];
  let ordinalReads = 0;
  const session = {
    checkDeadline() {},
    async query(query: string) {
      if (query.includes('# reading-position:work\n')) return [{ work: binding(work),
        structure: binding(structure), revision: binding(revision), generation: binding(revision) }];
      if (query.includes('# reading-position:range')) return occurrences.map((occurrence, index) => ({
        placement: binding(occurrence), occurrence: binding(occurrence), parent: binding(structure),
        segmentKey: binding(index < 2 ? 'a' : 'b'), orderKey: binding(index === 1 ? 'b' : 'a'),
        role: binding(RV + 'ChapterRole'), matches: binding('true'),
      }));
      if (query.includes('# reading-position:ordinals')) {
        ordinalReads++;
        // A graph-only match cannot bind the VALUES-only ?orderKey or the
        // prior-count branch's ?segmentKey. The existing mock used to hide this.
        for (const group of graphGroups(query)) expect(group).not.toMatch(/FILTER\(\?key </);
        expect(query).toContain('FILTER(?key < ?segmentKey)');
        expect(query).toContain('FILTER(?key < ?orderKey)');
        expect(query).toContain('FILTER NOT EXISTS { ?earlier rv:removedBy ?removed }');
        return occurrences.map((occurrence, index) => ({ occurrence: binding(occurrence), ordinal: binding(String(ordinals[index])) }));
      }
      throw new Error(`Unexpected traversal query: ${query}`);
    },
  } as unknown as WorkReadSession;
  const page = await new ReadingPositionTraversal(session, work, async resources => new Set(resources)).page({ limit: 3 });
  // Keep the graph comparison regression guard above; its physical counts,
  // including the 997 unreturned predecessors, never leave the public chooser.
  expect(page.items.map(item => item.occurrence)).toEqual(occurrences);
  expect(page.items.every(item => !Object.hasOwn(item, 'ordinal'))).toBe(true);
  expect(ordinalReads).toBe(1);
});

function zoneStorage(directory: string, name?: string, language?: string) {
  const configuration = { format: ZONE_CONFIG_FORMAT, zone, space, navigation: structure,
    state: 'active', disclosure: 'public', budget: { timeMs: ZONE_LIMITS.queryBudgetMs, rows: ZONE_LIMITS.queryBudgetRows },
    queryBlocks: [], model: ZONE_PROFILE };
  const manifest = prepareComponent(directory, zone, { configuration,
    ...(name !== undefined ? { name, language } : {}) }, ZONE_PROFILE);
  let terminal: Record<string, ReturnType<typeof binding>> | undefined;
  let registered: { id: string; action: string; scope: string; requestDigest: string; authorityEpoch: string;
    state: string; dispatchEligible: boolean; replayed: boolean };
  const envelopes: CommandEnvelope[] = [];
  const fuseki = {
    async query(query: string) {
      if (query.includes('SELECT ?outcome')) return rows(terminal ? [terminal] : []);
      if (query.includes('SELECT ?space ?navigation ?head')) return rows([{ space: binding(space),
        navigation: binding(structure), head: binding(revision), manifest: binding(`urn:rezics:sha256:${manifest}`),
        state: binding(RV + 'Active'), disclosure: binding(RV + 'Public'), spaceDisclosure: binding(RV + 'Public') }]);
      if (query.includes('ASK')) return { boolean: query.includes('rv:restoreHold') };
      throw new Error(`Unexpected Zone query: ${query}`);
    },
    async commandHealth() {
      return { profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, profile]) => [key, profile.sha256])) };
    },
    async commandWithReceipt(envelope: CommandEnvelope) {
      envelopes.push(envelope);
      const next = envelope.update.match(/rv:structureRevision <([^>]+)>/)?.[1];
      if (!next) throw new Error('Missing Zone revision');
      terminal = Object.fromEntries(Object.entries({ outcome: RV + 'Succeeded', digest: envelope.digest,
        admission: registered.id, epoch: registered.authorityEpoch, scope: registered.scope,
        dataEpoch: 'epoch', sequence: '2', owner: zone, revision: next }).map(([key, value]) => [key, binding(value)]));
      return { status: 'committed' as const };
    },
  };
  const access = {
    async register(input: { action: string; scope: string; requestDigest: string }) {
      registered = { ...input, id: id(20).slice(-36), authorityEpoch: '1', state: terminal ? 'sealed' : 'claimed',
        dispatchEligible: true, replayed: !!terminal };
      return registered as never;
    },
    async claim() { return registered as never; },
    async recordGraphOutcome() {},
  };
  const env = { fuseki, objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as unknown as WorkActivationEnvironment;
  return { env, access, account: { verify: async () => ({ issuer: 'test', subject: 'editor' }) }, envelopes };
}

const label = `<${zone}> <http://www.w3.org/2000/01/rdf-schema#label>`;
const request = () => new Request('http://main.test/v1/zones', { method: 'POST' });

test.each([['A canonical Site', 'en'], ['讀書', 'zh-hans'], ['العربية', undefined]] as const)(
  'G-974/G961: Zone creation projects the manifest name %s with its writer language', async (name, language) => {
    const directory = mkdtempSync(resolve('.temp/g-974-zone-'));
    try {
      const db = zoneStorage(directory);
      const input = { kind: 'zone' as const, owner: zone, space, actingSubject: actor, idempotencyKey: 'create',
        requestDigest: 'a'.repeat(64), disclosure: 'public' as const, name, language };
      const created = await createAdmittedOwner(db.env, db.account, db.access, request(), input);
      expect(await createAdmittedOwner(db.env, db.account, db.access, request(), input)).toEqual({ ...created, replayed: true });
      expect(db.envelopes).toHaveLength(1);
      expect(db.envelopes[0]!.update).toContain(`${label} ${JSON.stringify(name)}@${language === 'zh-hans' ? 'zh-Hans' : language ?? 'und'} .`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
);

test.each([
  ['rename', 'Old Site', 'en', { name: '新しい Site', language: 'ja' }, '新しい Site', 'ja'],
  ['retain', '讀書', 'zh-Hant', {}, '讀書', 'zh-Hant'],
  ['legacy unnamed', undefined, undefined, {}, undefined, undefined],
] as const)('G-974/G961: Zone configuration %s replaces its label atomically with the manifest', async (_operation, name, language, patch, nextName, nextLanguage) => {
  const directory = mkdtempSync(resolve('.temp/g-974-zone-'));
  try {
    const db = zoneStorage(directory, name, language);
    await changeZoneConfiguration(db.env, db.account, db.access, request(), { zone, expectedHead: revision,
      actingSubject: actor, idempotencyKey: 'configure', operation: 'configure', patch });
    expect(db.envelopes).toHaveLength(1);
    const update = db.envelopes[0]!.update;
    expect(update.slice(update.indexOf('DELETE'), update.indexOf('INSERT'))).toContain(`${label} ?oldName .`);
    expect(update).toContain(`OPTIONAL { ${label} ?oldName }`);
    const inserted = update.slice(update.indexOf('INSERT'), update.indexOf('WHERE'));
    if (nextName === undefined) expect(inserted).not.toContain(label);
    else expect(inserted).toContain(`${label} ${JSON.stringify(nextName)}@${nextLanguage} .`);
    const digest = inserted.match(/rv:manifest <urn:rezics:sha256:([0-9a-f]{64})>/)![1]!;
    const state = await readWorkComponentState(db.env, `urn:rezics:sha256:${digest}`, zone, ZONE_PROFILE);
    expect(state.name).toBe(nextName);
    expect(state.language).toBe(nextLanguage);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
