import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { readCollectionName, CollectionNameUnavailable } from '../src/modules/collection/names.ts';
import { createAdmittedOwner, type OwnerCreateInput } from '../src/modules/zone/owner-create.ts';
import { readZoneEditorLists } from '../src/modules/zone-modules/editor-lists.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../src/modules/zone/presentation-format.ts';
import { selectDisplayName } from '../src/modules/display-language/select.ts';
import { IdempotencyConflict, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { CommandEnvelope } from '../src/infrastructure/fuseki.ts';
import { InvalidCompositionChange } from '../src/modules/structure/change.ts';
import { collectionRoutes } from '../src/routes/collections.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1), actor = id(2), realm = id(3), zone = id(4);
const binding = (value: string) => ({ type: 'literal' as const, value });
const name = 'قراءات';

/** Exercise real owner validation, manifest preparation, graph envelope and
 * receipt replay. The graph double records the name from the write envelope. */
function ownerStorage(input: OwnerCreateInput, objectDirectory: string) {
  let terminal: Record<string, ReturnType<typeof binding>> | undefined;
  let plain: { value: string; 'xml:lang': string } | undefined;
  let admissionDigest: string | undefined;
  let writes = 0;
  const envelopes: CommandEnvelope[] = [];
  const admission = { id: '00000000-0000-4000-8000-000000000010', action: input.kind === 'zone' ? 'zone.edit' : 'collection.edit',
    scope: `${input.kind === 'zone' ? 'zone' : 'collection'}:edit:${input.owner}`,
    requestDigest: input.requestDigest, authorityEpoch: '1', state: 'claimed', dispatchEligible: true, replayed: false };
  const fuseki = {
    query: async (sql: string) => {
      if (sql.includes('SELECT ?outcome')) return { results: { bindings: terminal ? [terminal] : [] } };
      if (sql.includes('SELECT ?plain')) return { results: { bindings: plain ? [{ plain }] : [] } };
      if (sql.includes('ASK') && sql.includes('rv:restoreHold')) return { boolean: true };
      if (sql.includes('ASK') && sql.includes('rv:InvalidProfile')) return { boolean: false };
      if (sql.includes('ASK') && sql.includes('rv:realmCapability')) return { boolean: true };
      throw new Error(`Unexpected graph query: ${sql}`);
    },
    commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([key, profile]) => [key, profile.sha256])) }),
    commandWithReceipt: async (envelope: CommandEnvelope) => {
      envelopes.push(envelope);
      writes++;
      const label = /<https:\/\/schema.org\/name> ("(?:[^"\\]|\\.)*")@([A-Za-z0-9-]+)/u.exec(envelope.update);
      if (label) plain = { value: JSON.parse(label[1]!) as string, 'xml:lang': label[2]! };
      const revision = /rv:structureRevision <([^>]+)>/u.exec(envelope.update)?.[1];
      if (!revision) throw new Error('Missing owner revision');
      terminal = Object.fromEntries(Object.entries({ outcome: `${RV}Succeeded`,
        digest: envelope.digest, admission: admission.id, epoch: admission.authorityEpoch,
        scope: admission.scope, dataEpoch: 'epoch', sequence: '1', owner: input.owner, revision })
        .map(([key, value]) => [key, binding(value)]));
      return { status: 'committed' as const };
    },
  };
  const access = {
    register: async (request: { requestDigest: string }) => {
      if (admissionDigest && request.requestDigest !== admissionDigest) throw new IdempotencyConflict('key binds another language');
      admissionDigest = request.requestDigest;
      admission.requestDigest = request.requestDigest;
      return { ...admission, replayed: !!terminal, state: terminal ? 'sealed' : 'claimed' } as never;
    },
    claim: async () => admission as never,
    recordGraphOutcome: async () => {},
  };
  const env = { fuseki, objectDirectory, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as unknown as WorkActivationEnvironment;
  return { env, access, account: { verify: async () => ({ issuer: 'test', subject: 'editor' }) as never },
    plain: () => plain, writes: () => writes, envelopes };
}

for (const kind of ['zone', 'collection', 'definition'] as const) {
  for (const language of ['ar', 'zh-hans', 'x-reader', undefined]) test(`G-596 ${kind} creation preserves ${language ?? 'unrecorded'} name language, manifest and receipt replay`, async () => {
    const root = resolve(import.meta.dir, '../../../.temp');
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(`${root}/g-596-owner-`);
    try {
      const input: OwnerCreateInput = { kind, owner, actingSubject: actor, idempotencyKey: 'create',
        requestDigest: 'a'.repeat(64), disclosure: 'public', name, language,
        ...(kind === 'zone' ? { space: realm } : {}),
        ...(kind === 'definition' ? { query: { phrase: 'books', language: null }, resultBudget: 16 } : {}) };
      const recordedLanguage = language === 'zh-hans' ? 'zh-Hans' : language ?? 'und';
      // With no declared script, the Arabic text sets direction without supplying a language.
      const expectedDirection = recordedLanguage === 'zh-Hans' ? 'ltr' : 'rtl';
      const db = ownerStorage(input, directory);
      const request = new Request('http://main.test/v1/owners', { method: 'POST' });
      const created = await createAdmittedOwner(db.env, db.account, db.access, request, input);
      const replay = await createAdmittedOwner(db.env, db.account, db.access, request, input);
      expect(replay).toEqual({ ...created, replayed: true });
      expect(db.writes()).toBe(1);
      if (kind === 'zone') expect(db.plain()).toBeUndefined();
      else {
        expect(db.plain()).toEqual({ value: name, 'xml:lang': recordedLanguage });
        expect(selectDisplayName(new Map([[db.plain()!['xml:lang'], db.plain()!.value]]), ['en']))
          .toMatchObject({ value: name, language: recordedLanguage, direction: expectedDirection });
        if (kind === 'collection') {
          const current = await readCollectionName(db.env, owner);
          expect(selectDisplayName(current.name, ['en']))
            .toMatchObject({ value: name, language: recordedLanguage, direction: expectedDirection });
        }
      }
      const files = readdirSync(directory);
      const payloads = files.map(file => JSON.parse(readFileSync(`${directory}/${file}`, 'utf8')) as {
        format: string; state?: { name: string; language: string } });
      expect(payloads.find(payload => payload.format === 'rezics-component-v1')?.state)
        .toMatchObject({ name, language: recordedLanguage });
      if (kind === 'zone') {
        expect(db.envelopes[0]!.update).not.toContain('<https://schema.org/name>');
        expect(db.envelopes[0]!.update).toContain(`<${owner}> <http://www.w3.org/2000/01/rdf-schema#label> ${JSON.stringify(name)}@${recordedLanguage} .`);
      }
      expect(db.envelopes[0]!.validations.length).toBeLessThanOrEqual(2);
      await expect(createAdmittedOwner(db.env, db.account, db.access, request,
        { ...input, language: 'ja', requestDigest: 'b'.repeat(64) })).rejects.toBeInstanceOf(IdempotencyConflict);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('G-596 invalid owner languages fail before admission or graph work', async () => {
  for (const language of ['', 'en @evil', 'en-US; DROP', 'en--US', 'x']) {
    const input: OwnerCreateInput = { kind: 'zone', owner, actingSubject: actor,
      idempotencyKey: 'invalid', requestDigest: 'a'.repeat(64), disclosure: 'public', name, language };
    await expect(createAdmittedOwner({} as never, {} as never, {} as never,
      new Request('http://main.test/'), input)).rejects.toBeInstanceOf(InvalidCompositionChange);
  }
});

for (const tag of [undefined, '']) test(`G-596 class guard: ${tag === undefined ? 'missing' : 'empty'} RDF language is und in collection names and editor lists`, async () => {
  const plain = { value: name, ...(tag !== undefined ? { 'xml:lang': tag } : {}) };
  const env = { fuseki: { query: async () => ({ results: { bindings: [{ plain }] } }) } } as unknown as WorkActivationEnvironment;
  const read = await readCollectionName(env, owner);
  expect(read.name).toEqual({ original: 'und', labels: { und: name } });
  expect(selectDisplayName(read.name, ['en'])?.language).toBe('und');
  const presentation = { ...DEFAULT_ZONE_PRESENTATION, modules: [{ id: 'editors', type: 'editorial-list',
    title: 'Editors', source: { kind: 'collection', collection: owner } }] };
  const session = { deps: { environment: env }, displayLanguages: ['en'], position: { dataEpoch: 'epoch', sequence: '1' },
    query: async () => [{ collection: binding(owner), name: plain }], summaries: async () => [] } as unknown as WorkReadSession;
  const result = await readZoneEditorLists(session, realm,
    async () => ({ zone, realm, revision: zone, presentation }) as never,
    async () => ({ zone, realm, revision: zone, presentation, configuration: { presentation } }) as never,
    async () => [{ id: 'editors', sources: [{ source: { kind: 'collection', collection: owner }, state: 'available', members: [] }] }] as never);
  expect(result.lists[0]!.name).toMatchObject({ value: name, language: 'und' });
  expect(result.lists[0]!.name.language).not.toBe('en');
});

test('G-596 missing collection names are unavailable rather than manufactured', async () => {
  const env = { fuseki: { query: async () => ({ results: { bindings: [] } }) } } as unknown as WorkActivationEnvironment;
  await expect(readCollectionName(env, owner)).rejects.toBeInstanceOf(CollectionNameUnavailable);
});

test('G-596 RDF casing preserves the declared collection name language', async () => {
  const env = { fuseki: { query: async () => ({ results: { bindings: [{
    plain: { value: '讀書', 'xml:lang': 'zh-hant' } }] } }) } } as unknown as WorkActivationEnvironment;
  const current = await readCollectionName(env, owner);
  expect(current.name).toEqual({ original: 'zh-Hant', labels: { 'zh-Hant': '讀書' } });
});

test('G-596 collection-definition HTTP creation forwards name language and binds it to the command key', async () => {
  const root = resolve(import.meta.dir, '../../../.temp');
  const directory = mkdtempSync(`${root}/g-596-http-`);
  try {
    const input: OwnerCreateInput = { kind: 'definition', owner, actingSubject: actor,
      disclosure: 'public', requestDigest: '', idempotencyKey: 'definition', name, language: 'ar' };
    const db = ownerStorage(input, directory);
    const deps = { environment: db.env, access: db.access, account: db.account } as unknown as MainWorkDependencies;
    const app = collectionRoutes(db.env.fuseki, deps);
    const body = { definition: owner, name, language: 'ar', disclosure: 'public', actingSubject: actor,
      query: { phrase: 'books', language: null }, resultBudget: 16 };
    const send = (value: unknown) => app.handle(new Request('http://localhost/v1/collection-definitions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'definition' }, body: JSON.stringify(value) }));
    const first = await send(body);
    expect(first.status).toBe(201);
    expect(db.plain()).toEqual({ value: name, 'xml:lang': 'ar' });
    const second = await send(body);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ replayed: true });
    expect((await send({ ...body, language: 'ja' })).status).toBe(409);
    expect((await send({ ...body, language: 'en @evil' })).status).toBe(400);
    expect(db.writes()).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
