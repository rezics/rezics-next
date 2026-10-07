import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { profileSource } from '../../../model/compiler/shacl.ts';
import { authoredProfiles, commandProfiles } from '../../../model/compiler/generate.ts';
import { spaceZoneProfile } from '../../../model/definitions/space-zone-v1.ts';
import type { CommandEnvelope } from '../src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { spaceRoutes } from '../src/routes/spaces.ts';
import { createZoneSpace, zoneSpaceCreationDigest, SPACE_ZONE_CREATE_COST } from '../src/modules/space/create-zone.ts';
import { InvalidSpaceInput, readSpaceCreationReceipt, spaceCreationReceiptIri } from '../src/modules/space/create.ts';
import { zoneSpaceCreatorAllowed } from '../src/modules/space/create-authority.ts';
import { zoneSpaceCreatedEvent } from '../src/modules/space/outbox-event.ts';
import { derivedId } from '../src/modules/structure/graph.ts';
import { checkStructureManifest } from '../src/modules/structure/format.ts';
import { IdempotencyConflict, PendingActivation, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const actor = `https://rezics.com/id/${randomUUID()}`;
const lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
const source = { name: 'Independent site', language: 'ar', actingSubject: actor, visibility: 'public' as const };
// A shared wave regenerates once at integration. Install only this reviewed
// profile in this test process; never write or replace the shared generated files.
const registry = profileRegistry as Record<string, { sha256: string; shapes: readonly string[] }>;
const currentDigest = createHash('sha256').update(profileSource(spaceZoneProfile)).digest('hex');
const generated = registry['space-zone-v1'];
beforeAll(() => { registry['space-zone-v1'] = { sha256: currentDigest,
  shapes: spaceZoneProfile.shapes.map(shape => shape.iri) }; });
afterAll(() => { if (generated) registry['space-zone-v1'] = generated; else delete registry['space-zone-v1']; });

function fixture() {
  const directory = mkdtempSync(resolve('.temp/g-963-zone-'));
  const admission: RegisteredAdmission = { id: randomUUID(), principalId: randomUUID(), actingSubject: actor,
    scope: 'space:create:root', action: 'space.create', idempotencyKey: 'zone-create',
    requestDigest: zoneSpaceCreationDigest(source), authorityEpoch: '3',
    state: 'claimed', expiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEligible: true, replayed: false };
  let binding: Record<string, { value: string }> | null = null;
  const commands: CommandEnvelope[] = [], objects = new Map<string, Uint8Array>();
  const names: Record<string, string> = { space: `https://rezics.com/id/${admission.id}`,
    zone: derivedId(`${admission.id}\0space-zone`), spaceRevision: derivedId(`${admission.id}\0space-revision`),
    zoneRevision: derivedId(`${admission.id}\0zone-revision`), navigation: derivedId(`${admission.id}\0zone-navigation`),
    navigationRevision: derivedId(`${admission.id}\0navigation-revision`), owner: actor };
  let loseResponse = false, commit = true;
  const graph = {
    query: async (query: string) => {
      if (query.includes('SELECT\n    ?outcome')) return { results: { bindings: binding ? [binding] : [] } };
      if (query.includes('SELECT ?zone ?owner ?name')) return { results: { bindings: binding ? [{
        ...binding, name: { value: source.name, 'xml:lang': 'ar' }, listing: { value: 'listed' } }] : [] } };
      return { boolean: query.includes('rv:routingEpoch') };
    },
    commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(registry).map(([id, profile]) => [id, profile.sha256])) }),
    commandWithReceipt: async (envelope: CommandEnvelope) => {
      commands.push(envelope);
      if (commit) binding = Object.fromEntries(Object.entries({ ...names, outcome: `${RV}Succeeded`,
        digest: envelope.digest, id: admission.id, epoch: admission.authorityEpoch, scope: admission.scope,
        dataEpoch: lineage.dataEpoch, sequence: '7' }).map(([key, value]) => [key, { value }]));
      if (loseResponse) throw new Error('lost graph response');
      return { status: 'committed' as const };
    },
  };
  const env = { fuseki: graph, lineage, objectDirectory: directory,
    structureObjects: { put: async (bytes: Uint8Array) => {
      const digest = createHash('sha256').update(bytes).digest('hex'); objects.set(digest, bytes); return digest;
    }, get: async (digest: string) => objects.get(digest)! } } as unknown as WorkActivationEnvironment;
  return { env, graph, admission, names, commands, objects,
    set loseResponse(value: boolean) { loseResponse = value; }, set commit(value: boolean) { commit = value; },
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('G-963: Zone creation binds capability, normalized handle, visibility and listing to one intent', () => {
  expect(createHash('sha256').update(profileSource(spaceZoneProfile)).digest('hex')).toBe(currentDigest);
  const input = { ...source, handle: 'Reading-Site' };
  const digest = zoneSpaceCreationDigest(input);
  expect(digest).toBe(zoneSpaceCreationDigest({ ...input, handle: 'reading-site', listing: 'listed' }));
  expect(digest).not.toBe(zoneSpaceCreationDigest({ ...input, visibility: 'private' }));
  expect(digest).not.toBe(zoneSpaceCreationDigest({ ...input, listing: 'unlisted' }));
  for (const invalid of [{ name: ' ' }, { handle: 'bad handle' }, { language: 'bad-tag-!' },
    { visibility: 'unlisted' }, { listing: 'private' }]) {
    expect(() => zoneSpaceCreationDigest({ ...input, ...invalid } as typeof input)).toThrow(InvalidSpaceInput);
  }
});

test('G-963: the Zone-only Space profile compiles beside every accepted Realm profile', () => {
  const compiled = commandProfiles(authoredProfiles);
  expect(compiled.profiles.find(profile => profile.id === 'space-zone-v1'))
    .toMatchObject({ sha256: currentDigest, focusRoles: ['space'] });
});

test('G-963: Space, Realm-free Zone and navigation commit atomically, validate every component and resolve a lost response', async () => {
  const f = fixture();
  try {
    f.loseResponse = true;
    const created = await createZoneSpace(f.env, f.admission, source);
    expect(created).toMatchObject(f.names);
    expect(created.realm).toBeUndefined();
    expect(f.commands).toHaveLength(SPACE_ZONE_CREATE_COST.graphCommandCalls);
    const command = f.commands[0]!;
    expect(command.update).not.toContain('rv:realmCapability');
    expect(command.update).not.toContain('a rv:Realm');
    expect(command.update).toContain('rv:listing "listed"');
    const shapes = command.validations.map(validation => validation.shape);
    expect(shapes).toContain('https://rezics.com/definition/space-zone-v1/space-shape');
    expect(shapes).toContain('https://rezics.com/definition/zone-capability-v1/zone-shape');
    expect(shapes).toContain('https://rezics.com/definition/zone-capability-v1/revision-shape');
    expect(shapes).toContain('https://rezics.com/definition/structure-composition-v1/structure-shape');
    expect(shapes).toContain('https://rezics.com/definition/zone-capability-v1/navigation-link-shape');
    const manifest = [...f.objects.values()].find(bytes => new TextDecoder().decode(bytes).includes('structureOf'))!;
    expect(checkStructureManifest(manifest)).toMatchObject({ structure: created.navigation,
      structureOf: created.zone, profile: 'zone-navigation', placementCount: 0 });
    const componentObjects = readdirSync(f.env.objectDirectory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).length;
    expect(componentObjects + f.objects.size).toBe(SPACE_ZONE_CREATE_COST.immutableWrites);
    expect(await createZoneSpace(f.env, f.admission, source)).toEqual(created);
    expect(f.commands).toHaveLength(1);
    await expect(createZoneSpace(f.env, f.admission, { ...source, listing: 'unlisted' }))
      .rejects.toBeInstanceOf(IdempotencyConflict);
  } finally { f.close(); }
});

test('G-963: an uncommitted retry uses the same site identities and cannot return partial success', async () => {
  const f = fixture();
  try {
    f.commit = false; f.loseResponse = true;
    await expect(createZoneSpace(f.env, f.admission, source)).rejects.toBeInstanceOf(PendingActivation);
    f.commit = true; f.loseResponse = false;
    expect(await createZoneSpace(f.env, f.admission, source)).toMatchObject(f.names);
    expect(f.commands.map(command => command.update)).toEqual([f.commands[0]!.update, f.commands[0]!.update]);
  } finally { f.close(); }
});

test('G-963: the public Space API uses only Space creation authority and exposes a Zone-only read', async () => {
  const f = fixture();
  try {
    const scopes: string[][] = [], admissions: Record<string, unknown>[] = [];
    const access = { register: async (request: Record<string, unknown>) => {
      admissions.push(request); return { ...f.admission, requestDigest: request.requestDigest };
    }, claim: async () => f.admission, recordGraphOutcome: async () => {} };
    const work = { environment: f.env, access, account: { verify: async (_request: Request, required: string[]) => {
      scopes.push(required); return { issuer: 'https://account.test', subject: 'creator' };
    } } } as unknown as MainWorkDependencies;
    const app = spaceRoutes(f.env.fuseki, work);
    const command = { profile: 'space-zone-v1', capabilities: ['zone'], ...source };
    const send = (body = command) => app.handle(new Request('http://main.local/v1/spaces', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'zone-create' },
      body: JSON.stringify(body) }));
    const response = await send();
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({ ...f.names, capabilities: ['zone'], replayed: false });
    expect(scopes).toEqual([['space:create']]);
    expect(admissions).toMatchObject([{ scope: 'space:create:root', action: 'space.create', actingSubject: actor }]);
    expect((await send({ ...command, capabilities: ['realm'] })).status).toBe(422);
    const read = await app.handle(new Request(`http://main.local/v1/spaces/${f.admission.id}`));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ capabilities: ['zone'], name: source.name,
      language: 'ar', direction: 'rtl', visibility: 'public', listing: 'listed' });
    expect(await readSpaceCreationReceipt(f.env, f.admission.id)).toMatchObject(f.names);
  } finally { f.close(); }
});

test('G-963: private site authority requires the exact sealed creator receipt and live Agent control', async () => {
  const admission = randomUUID(), receipt = spaceCreationReceiptIri(admission), digest = 'a'.repeat(64);
  let allowed = true;
  const sql: string[] = [];
  const graph = { query: async () => ({ results: { bindings: [{ admission: { value: admission },
    receipt: { value: receipt }, digest: { value: digest } }] } }) };
  const client = { query: async (query: string) => { sql.push(query); return { rowCount: allowed ? 1 : 0 }; } };
  expect(await zoneSpaceCreatorAllowed(client as never, graph as never, randomUUID(), actor, actor)).toBe(true);
  expect(sql[0]).toContain("r.action = 'agent.control'");
  expect(sql[0]).toContain("a.state = 'sealed' AND a.graph_outcome = 'succeeded'");
  allowed = false;
  expect(await zoneSpaceCreatorAllowed(client as never, graph as never, randomUUID(), actor, actor)).toBe(false);
  expect(await zoneSpaceCreatorAllowed(client as never, undefined, randomUUID(), actor, actor)).toBe(false);
});

test('G-963: the owner event retains Zone identity and rejects a fabricated Realm', async () => {
  const f = fixture();
  try {
    const operation = derivedId(`${f.admission.id}\0space-operation`);
    const values: Record<string, string> = { receipt: spaceCreationReceiptIri(f.admission.id), operation,
      eventOperation: operation, space: f.names.space!, eventSpace: f.names.space!, outcome: `${RV}Succeeded`,
      epoch: lineage.dataEpoch, sequence: '7', digest: f.admission.requestDigest,
      admissionId: f.admission.id, authorityEpoch: '3', scope: f.admission.scope };
    const input = { fuseki: { query: async () => ({ results: { bindings: [Object.fromEntries(
      Object.entries(f.names).map(([name, value]) => [name, { value }]))] } }) } as never,
      batch: { batchId: 'batch', routingEpoch: lineage.routingEpoch, dataEpoch: lineage.dataEpoch, sequence: '7' } as never,
      eventId: `urn:rezics:event:${createHash('sha256').update(operation).digest('hex')}`,
      value: (name: string) => values[name], ordinal: 0 };
    expect((await zoneSpaceCreatedEvent.read(input)).data.receipt).toMatchObject({
      capabilities: ['zone'], zone: f.names.zone, admissionId: f.admission.id });
    values.realm = actor;
    await expect(zoneSpaceCreatedEvent.read(input)).rejects.toThrow('differs');
  } finally { f.close(); }
});
