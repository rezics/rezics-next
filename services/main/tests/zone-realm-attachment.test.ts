import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { CommandEnvelope } from '../src/infrastructure/fuseki.ts';
import { AdmissionDenied, AdmissionExpired } from '../src/modules/access/admission.ts';
import { fromPlainText } from '@rezics/document';
import type { ContentCore } from '../../content/src/core.ts';
import { baselineTarget } from '../src/modules/access/baseline.ts';
import { RV, prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { ZONE_CONFIG_FORMAT, ZONE_LIMITS, ZONE_PROFILE, InvalidZoneConfiguration } from '../src/modules/zone/config-format.ts';
import { changeZoneConfiguration, readZoneConfiguration, readZoneRevisionConfiguration, publishZoneSite,
  ZoneStale, ZoneUnavailable } from '../src/modules/zone/configuration.ts';
import { realmAttachAllowed } from '../src/modules/zone/realm-attachment-authority.ts';
import { withdrawZoneRealmAttachment } from '../src/modules/zone/realm-attachment-withdrawal.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const zone = id(1), zoneSpace = id(2), navigation = id(3), head = id(4), actor = id(5);
const sameSpaceRealm = id(10), foreignRealm = id(11), otherRealm = id(13);
const navigationRoute = navigation;
const lit = (value: string) => ({ type: 'literal' as const, value });
const rows = (bindings: Record<string, ReturnType<typeof lit>>[]) => ({ results: { bindings } });

interface Fixture {
  /** Realm → Space for Active Realms the graph can see. */
  realms?: Record<string, string>;
  /** The Zone's graph head: its Realm link, attachment and withdrawal. */
  link?: { realm?: string; attachment?: { by: string } };
  /** The Zone's stored configuration also names this Realm. */
  stored?: string;
}

function world(directory: string, fixture: Fixture = {}) {
  const configuration = { format: ZONE_CONFIG_FORMAT, zone, space: zoneSpace, navigation,
    state: 'active', disclosure: 'public', budget: { timeMs: ZONE_LIMITS.queryBudgetMs, rows: ZONE_LIMITS.queryBudgetRows },
    queryBlocks: [], model: ZONE_PROFILE, ...(fixture.stored ? { defaultRealm: fixture.stored } : {}) };
  const manifest = prepareComponent(directory, zone, { configuration, name: 'Site', language: 'en' }, ZONE_PROFILE);
  const state = {
    realms: { [sameSpaceRealm]: zoneSpace, ...fixture.realms } as Record<string, string>,
    link: fixture.link ?? {}, queries: [] as string[], envelopes: [] as CommandEnvelope[],
    terminal: undefined as Record<string, ReturnType<typeof lit>> | undefined,
    admission: undefined as unknown as { id: string; action: string; scope: string; requestDigest: string;
      authorityEpoch: string },
    attachChecks: [] as string[], ownerChecks: [] as string[], recorded: [] as string[],
    attachAuthority: 'held' as 'held' | 'denied' | 'expired', ownerAuthority: 'held' as 'held' | 'denied',
    attachmentLive: true,
    /** Runs once, as a command reaches the graph: the race window after the editor read the head. */
    beforeApply: undefined as undefined | (() => void),
    /** Graph state after the guarded updates the fake applied. */
    applied: [] as string[],
  };
  const fuseki = {
    async query(query: string) {
      state.queries.push(query);
      if (query.includes('SELECT ?outcome')) return rows(state.terminal ? [state.terminal] : []);
      if (query.includes('SELECT ?space ?navigation ?head')) {
        const { realm, attachment: linked } = state.link;
        return rows([{ space: lit(zoneSpace), navigation: lit(navigation), head: lit(head),
          manifest: lit(`urn:rezics:sha256:${manifest}`), state: lit(RV + 'Active'),
          disclosure: lit(RV + 'Public'), spaceDisclosure: lit(RV + 'Public'),
          ...(realm ? { realm: lit(realm) } : {}),
          ...(linked ? { attachedBy: lit(linked.by) } : {}) }]);
      }
      if (query.includes('SELECT DISTINCT ?type')) return rows([{ type: lit(RV + 'Zone') }]);
      if (query.includes('rv:structureHead')) return { boolean: true };
      if (query.includes('SELECT ?manifest WHERE')) return rows([{ manifest: lit(`urn:rezics:sha256:${manifest}`) }]);
      if (query.includes('SELECT ?space WHERE')) {
        const realm = Object.keys(state.realms).find(candidate => query.includes(`<${candidate}>`));
        return rows(realm ? [{ space: lit(state.realms[realm]!) }] : []);
      }
      if (query.includes('rv:realmAttachment ?attachment ;')) return { boolean: state.attachmentLive };
      if (query.includes('ASK')) {
        const realm = Object.keys(state.realms).find(candidate => query.includes(`<${candidate}> rv:space`));
        return { boolean: realm ? state.realms[realm] === zoneSpace : query.includes('rv:restoreHold') };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    async commandHealth() {
      return { profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, profile]) => [key, profile.sha256])) };
    },
    async commandWithReceipt(envelope: CommandEnvelope) {
      state.envelopes.push(envelope);
      const race = state.beforeApply;
      if (race && envelope.update.includes('rv:Succeeded')) {
        state.beforeApply = undefined;
        race();
      }
      // The graph matches the WHERE: an edit keeping the Realm needs the record it read.
      const where = envelope.update.slice(envelope.update.indexOf('WHERE'));
      if (envelope.update.includes('rv:Succeeded') && where.includes(`rv:realmAttachedBy <${actor}>`)
        && !state.link.attachment) return { status: 'guard-unmatched' as const };
      if (envelope.update.includes('rv:Succeeded')) state.applied.push(envelope.update);
      if (!envelope.update.includes('rv:Succeeded')) {
        state.terminal = Object.fromEntries(Object.entries({ outcome: RV + 'Cancelled', digest: envelope.digest,
          admission: state.admission.id, epoch: state.admission.authorityEpoch, scope: state.admission.scope,
          dataEpoch: 'epoch', sequence: '3' }).map(([key, value]) => [key, lit(value)]));
        return { status: 'committed' as const };
      }
      state.terminal = Object.fromEntries(Object.entries({ outcome: RV + 'Succeeded', digest: envelope.digest,
        admission: state.admission.id, epoch: state.admission.authorityEpoch, scope: state.admission.scope,
        dataEpoch: 'epoch', sequence: '2', owner: zone,
        revision: envelope.update.match(/rv:structureRevision <([^>]+)>/)?.[1] ?? '' })
        .map(([key, value]) => [key, lit(value)]));
      return { status: 'committed' as const };
    },
  };
  const access = {
    async register(input: { action: string; scope: string; requestDigest: string }) {
      state.admission = { ...input, id: id(20).slice(-36), authorityEpoch: '1' };
      return { ...state.admission, state: 'claimed', dispatchEligible: true, replayed: false } as never;
    },
    async claim() { return { ...state.admission, state: 'claimed', dispatchEligible: true } as never; },
    async recordGraphOutcome(admission: string, proof: { outcome: string }) {
      state.recorded.push(`${admission}:${proof.outcome}`);
    },
    async assertAuthority(request: { action: string; scope: string }) {
      state.attachChecks.push(`${request.action}@${request.scope}`);
      if (state.attachAuthority === 'denied') throw new AdmissionDenied('permission is not granted');
      if (state.attachAuthority === 'expired') throw new AdmissionExpired('grant expired');
    },
    async activePrincipalId() { return 'principal'; },
    async withOwnerAuthority<T>(request: { action: string; scope: string }, operation: (client: never) => Promise<T>) {
      // Content's page pin is exercised by its own tests; here it only has to succeed.
      if (request.action === 'content.publish') return {
        publicationGuard: '', position: { dataEpoch: '11111111-1111-4111-8111-111111111111', sequence: '1' },
        reference: { language: { kind: 'tag', tag: 'en' } } } as T;
      state.ownerChecks.push(`${request.action}@${request.scope}`);
      if (state.ownerAuthority === 'denied') throw new AdmissionDenied('permission is not granted');
      return operation(undefined as never);
    },
  };
  const env = { fuseki, objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    addresses: { currents: async () => new Map() } } as unknown as WorkActivationEnvironment;
  return { env, access, account: { verify: async () => ({ issuer: 'test', subject: 'editor' }) }, state };
}

const request = () => new Request('http://main.test/v1/zones', { method: 'PUT' });
const configure = (w: ReturnType<typeof world>, patch: Record<string, unknown>) =>
  changeZoneConfiguration(w.env, w.account, w.access, request(), { zone, expectedHead: head, actingSubject: actor,
    idempotencyKey: 'configure', operation: 'configure', patch });
const inDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = mkdtempSync(resolve('.temp/zone-realm-attachment-'));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

test('attaching a Realm from another Space needs both authorities and records a revocable link', async () => {
  await inDirectory(async directory => {
    const w = world(directory, { realms: { [foreignRealm]: id(99) } });
    const result = await configure(w, { defaultRealm: foreignRealm });
    expect(result.zone).toBe(zone);
    expect(w.state.attachChecks).toEqual([`realm.attach@realm:attach:${foreignRealm}`]);
    expect(w.state.ownerChecks).toEqual([`realm.attach@realm:attach:${foreignRealm}`]);
    const update = w.state.envelopes[0]!.update;
    const inserted = update.slice(update.indexOf('INSERT'), update.indexOf('WHERE'));
    expect(inserted).toContain(`<${zone}> rv:defaultRealm <${foreignRealm}>`);
    expect(inserted).toMatch(new RegExp(`<${zone}> rv:realmAttachedBy <${actor}> ;\\s+rv:realmAttachment <urn:rezics:receipt:[0-9a-f]{64}> \\.`));
    expect(update.slice(update.indexOf('DELETE'), update.indexOf('INSERT'))).toContain('rv:realmAttachment ?oldAttachment');
  });
});

test('a Realm in the Zone\'s own Space keeps today\'s rule and asks no steward', async () => {
  await inDirectory(async directory => {
    const w = world(directory);
    await configure(w, { defaultRealm: sameSpaceRealm });
    expect(w.state.attachChecks).toEqual([]);
    expect(w.state.ownerChecks).toEqual([]);
    expect(w.state.envelopes[0]!.update).not.toContain('rv:ZoneRealmAttachment');
  });
});

test('missing, invisible and unauthorised Realms are refused with one answer', async () => {
  await inDirectory(async directory => {
    const answers: string[] = [];
    for (const arrange of [
      (_w: ReturnType<typeof world>) => otherRealm, // absent from the graph: never asked
      (w: ReturnType<typeof world>) => { w.state.attachAuthority = 'denied'; return foreignRealm; },
      (w: ReturnType<typeof world>) => { w.state.attachAuthority = 'expired'; return foreignRealm; },
    ]) {
      const w = world(directory, { realms: { [foreignRealm]: id(99) } });
      const realm = arrange(w);
      const error = await configure(w, { defaultRealm: realm }).then(() => null, caught => caught);
      expect(error).toBeInstanceOf(InvalidZoneConfiguration);
      answers.push(`${(error as Error).name}:${(error as Error).message}`);
      expect(w.state.envelopes.at(-1)?.update.includes('rv:Succeeded') ?? false).toBe(false);
      expect(w.state.recorded).toEqual([`${w.state.admission.id}:cancelled`]);
      expect(String((error as Error).message)).not.toContain(realm);
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain('default Realm is unavailable');
  });
});

test('authority lost between the check and the graph switch is refused alike and writes nothing', async () => {
  await inDirectory(async directory => {
    const w = world(directory, { realms: { [foreignRealm]: id(99) } });
    w.state.ownerAuthority = 'denied';
    await expect(configure(w, { defaultRealm: foreignRealm }))
      .rejects.toThrow(new InvalidZoneConfiguration('default Realm is unavailable'));
    expect(w.state.envelopes.every(envelope => !envelope.update.includes('rv:ZoneRealmAttachment'))).toBe(true);
    expect(w.state.recorded).toEqual([`${w.state.admission.id}:cancelled`]);
  });
});

test('an unrelated edit keeps a live cross-Space attachment without asking the steward again', async () => {
  await inDirectory(async directory => {
    const w = world(directory, { realms: { [foreignRealm]: id(99) }, stored: foreignRealm,
      link: { realm: foreignRealm, attachment: { by: actor } } });
    await configure(w, { name: 'Renamed' });
    expect(w.state.attachChecks).toEqual([]);
    const update = w.state.envelopes[0]!.update;
    expect(update).toContain(`<${zone}> rv:defaultRealm <${foreignRealm}>`);
    // The link triples are only guarded, never deleted or rewritten.
    expect(update.slice(0, update.indexOf('WHERE'))).not.toContain('rv:realmAttachment');
  });
});

test('re-submitting the attached Realm keeps its record, asks no steward and leaves later edits and withdrawal working', async () => {
  await inDirectory(async directory => {
    const w = world(directory, { realms: { [foreignRealm]: id(99) }, stored: foreignRealm,
      link: { realm: foreignRealm, attachment: { by: actor } } });
    await configure(w, { defaultRealm: foreignRealm });
    expect(w.state.attachChecks).toEqual([]);
    expect(w.state.ownerChecks).toEqual([]);
    const resubmitted = w.state.envelopes[0]!.update;
    expect(resubmitted).toContain(`<${zone}> rv:defaultRealm <${foreignRealm}>`);
    expect(resubmitted.slice(0, resubmitted.indexOf('WHERE'))).not.toContain('rv:realmAttach');
    expect(resubmitted.slice(resubmitted.indexOf('WHERE'))).toContain(`rv:realmAttachedBy <${actor}>`);
    // The record is untouched, so the next unrelated edit still succeeds.
    w.state.terminal = undefined; // the fake keeps one receipt per command
    await changeZoneConfiguration(w.env, w.account, w.access, request(), { zone, expectedHead: head,
      actingSubject: actor, idempotencyKey: 'rename', operation: 'configure', patch: { name: 'Renamed' } });
    expect(w.state.attachChecks).toEqual([]);
    expect(w.state.envelopes).toHaveLength(2);
    // A steward can still withdraw it.
    w.state.terminal = undefined;
    const result = await withdrawZoneRealmAttachment(w.env, w.account, w.access, request(),
      { zone, realm: foreignRealm, actingSubject: actor, idempotencyKey: 'withdraw' });
    expect(result).toMatchObject({ zone, realm: foreignRealm });
    const gone = world(directory, { realms: { [foreignRealm]: id(99) }, stored: foreignRealm, link: {} });
    expect((await readZoneConfiguration(gone.env, zone)).configuration.defaultRealm).toBeUndefined();
  });
});

/** No Zone may hold a foreign Realm without the record that lets a steward withdraw it. */
const resurrected = (w: ReturnType<typeof world>) => w.state.applied.some(update => {
  const inserted = update.slice(update.indexOf('INSERT'), update.indexOf('WHERE'));
  return inserted.includes(`rv:defaultRealm <${foreignRealm}>`) && !inserted.includes('rv:realmAttachment ');
});
const attachedWorld = (directory: string) => world(directory, { realms: { [foreignRealm]: id(99) },
  stored: foreignRealm, link: { realm: foreignRealm, attachment: { by: actor } } });

test('a withdrawal that lands between an unrelated edit\'s read and commit cannot be undone by it', async () => {
  await inDirectory(async directory => {
    const w = attachedWorld(directory);
    w.state.beforeApply = () => { w.state.link = {}; };
    await expect(configure(w, { name: 'Renamed' })).rejects.toBeInstanceOf(ZoneStale);
    expect(resurrected(w)).toBe(false);
    expect(w.state.applied).toEqual([]);
    expect(w.state.recorded).toEqual([`${w.state.admission.id}:cancelled`]);
    // After the withdrawal the same edit reads the new state and commits without the Realm.
    const after = world(directory, { realms: { [foreignRealm]: id(99) }, stored: foreignRealm, link: {} });
    await configure(after, { name: 'Renamed' });
    expect(resurrected(after)).toBe(false);
    const inserted = after.state.applied[0]!;
    expect(inserted.slice(inserted.indexOf('INSERT'), inserted.indexOf('WHERE'))).not.toContain('rv:defaultRealm');
  });
});

test('a withdrawal that lands between a publish\'s read and commit cannot be undone by it', async () => {
  await inDirectory(async directory => {
    const revision = '11111111-1111-4111-8111-111111111111';
    const content = { ownerPosition: async () => ({ dataEpoch: revision }),
      owningResourceForRevision: async () => zone,
      readExactBatch: async () => [{ status: 'available', reference: { variantId: `urn:rezics:variant:${revision}`,
        byteDigest: 'a'.repeat(64) }, body: { document: fromPlainText('Home', 'blocks') } }],
      readPublicationPreparation: async () => null } as unknown as ContentCore;
    const publish = (w: ReturnType<typeof world>) => publishZoneSite(w.env, w.account, w.access, request(), {
      zone, expectedHead: head, actingSubject: actor, idempotencyKey: 'publish', routesRevision: navigationRoute,
      navigationRevision: navigationRoute, pages: [{ page: zone, variantId: `urn:rezics:variant:${revision}`,
        revisionId: revision, byteDigest: 'a'.repeat(64), contentEpoch: revision }] }, content);
    const w = attachedWorld(directory);
    w.state.beforeApply = () => { w.state.link = {}; };
    await expect(publish(w)).rejects.toBeInstanceOf(ZoneStale);
    expect(resurrected(w)).toBe(false);
    expect(w.state.applied).toEqual([]);
    // The guard is part of the publish itself, not only of plain edits.
    const guarded = attachedWorld(directory);
    await publish(guarded).catch(() => undefined);
    const update = guarded.state.envelopes.find(envelope => envelope.update.includes('rv:Succeeded'))!.update;
    expect(update.slice(update.indexOf('WHERE'))).toContain(`rv:realmAttachedBy <${actor}>`);
  });
});

test('a Zone editor removes the Realm and the link with it', async () => {
  await inDirectory(async directory => {
    const w = world(directory, { realms: { [foreignRealm]: id(99) }, stored: foreignRealm,
      link: { realm: foreignRealm, attachment: { by: actor } } });
    await configure(w, { defaultRealm: null });
    const update = w.state.envelopes[0]!.update;
    expect(update.slice(update.indexOf('DELETE'), update.indexOf('INSERT'))).toContain('rv:realmAttachment ?oldAttachment');
    expect(update.slice(update.indexOf('INSERT'), update.indexOf('WHERE'))).not.toContain('rv:defaultRealm');
    expect(w.state.attachChecks).toEqual([]);
  });
});

test('a steward\'s withdrawal ends the attachment on every Zone read', async () => {
  await inDirectory(async directory => {
    const live = world(directory, { realms: { [foreignRealm]: id(99) }, stored: foreignRealm,
      link: { realm: foreignRealm, attachment: { by: actor } } });
    const before = await readZoneConfiguration(live.env, zone);
    expect(before.defaultRealm).toBe(foreignRealm);
    expect(before.configuration.defaultRealm).toBe(foreignRealm);
    // The graph drops the live link; stored configuration bytes are immutable
    // and still name the Realm.
    const gone = world(directory, { realms: { [foreignRealm]: id(99) }, stored: foreignRealm, link: {} });
    const after = await readZoneConfiguration(gone.env, zone);
    expect(after.defaultRealm).toBeUndefined();
    expect(after.configuration.defaultRealm).toBeUndefined();
    // The published cut cannot revive it: a publish after withdrawal binds no Realm.
    const cut = await readZoneRevisionConfiguration(gone.env, after, head);
    expect(cut.configuration.defaultRealm).toBeUndefined();
  });
});

test('a published cut keeps only a Realm that is still linked or in the Zone\'s own Space', async () => {
  await inDirectory(async directory => {
    const replaced = world(directory, { realms: { [foreignRealm]: id(99) }, stored: foreignRealm,
      link: { realm: sameSpaceRealm } });
    const current = await readZoneConfiguration(replaced.env, zone);
    expect((await readZoneRevisionConfiguration(replaced.env, current, head)).configuration.defaultRealm).toBeUndefined();
    const sameSpace = world(directory, { stored: sameSpaceRealm, link: {} });
    const unlinked = await readZoneConfiguration(sameSpace.env, zone);
    expect((await readZoneRevisionConfiguration(sameSpace.env, unlinked, head)).configuration.defaultRealm).toBe(sameSpaceRealm);
  });
});

test('honouring the link costs the same read count with 1 and 50 attached Zones', async () => {
  const costs: number[] = [];
  for (const attached of [1, 50]) {
    await inDirectory(async directory => {
      const worlds = Array.from({ length: attached }, () => world(directory, { realms: { [foreignRealm]: id(99) },
        stored: foreignRealm, link: { realm: foreignRealm, attachment: { by: actor } } }));
      for (const w of worlds) await readZoneConfiguration(w.env, zone);
      costs.push(worlds.reduce((sum, w) => sum + w.state.queries.length, 0) / attached);
    });
  }
  expect(costs[0]).toBe(costs[1]!);
  expect(costs[0]).toBeLessThanOrEqual(2);
});

test('a steward withdraws the attachment under their own grant, held through the switch', async () => {
  await inDirectory(async directory => {
    const w = world(directory, { realms: { [foreignRealm]: id(99) }, stored: foreignRealm,
      link: { realm: foreignRealm, attachment: { by: actor } } });
    const result = await withdrawZoneRealmAttachment(w.env, w.account, w.access, request(),
      { zone, realm: foreignRealm, actingSubject: actor, idempotencyKey: 'withdraw' });
    expect(result).toMatchObject({ zone, realm: foreignRealm, replayed: false, sequence: '2' });
    expect(w.state.admission).toMatchObject({ action: 'realm.attach', scope: `realm:attach:${foreignRealm}` });
    expect(w.state.ownerChecks).toEqual([`realm.attach@realm:attach:${foreignRealm}`]);
    const update = w.state.envelopes[0]!.update;
    expect(update.slice(update.indexOf('DELETE'), update.indexOf('INSERT')))
      .toContain(`<${zone}> rv:defaultRealm <${foreignRealm}>`);
    expect(update.slice(update.indexOf('DELETE'), update.indexOf('INSERT')))
      .toContain('rv:realmAttachedBy ?by ; rv:realmAttachment ?attachment');
    expect(update.slice(update.indexOf('INSERT'), update.indexOf('WHERE'))).not.toContain('rv:defaultRealm');
  });
});

test('withdrawing an attachment that is gone, or after the grant is lost, changes nothing', async () => {
  await inDirectory(async directory => {
    const gone = world(directory, { realms: { [foreignRealm]: id(99) } });
    gone.state.attachmentLive = false;
    await expect(withdrawZoneRealmAttachment(gone.env, gone.account, gone.access, request(),
      { zone, realm: foreignRealm, actingSubject: actor, idempotencyKey: 'withdraw' })).rejects.toThrow(ZoneUnavailable);
    expect(gone.state.envelopes.every(envelope => envelope.update.includes('rv:Cancelled'))).toBe(true);
    expect(gone.state.recorded).toEqual([`${gone.state.admission.id}:cancelled`]);

    const lost = world(directory, { realms: { [foreignRealm]: id(99) } });
    lost.state.ownerAuthority = 'denied';
    await expect(withdrawZoneRealmAttachment(lost.env, lost.account, lost.access, request(),
      { zone, realm: foreignRealm, actingSubject: actor, idempotencyKey: 'withdraw' })).rejects.toThrow(AdmissionDenied);
    expect(lost.state.envelopes.every(envelope => !envelope.update.includes('rv:Succeeded'))).toBe(true);
  });
});

test('realm.attach is a baseline target only on its own scope and judged on the Realm\'s steward grants', async () => {
  expect(baselineTarget('realm.attach', `realm:attach:${foreignRealm}`)).toEqual({ kind: 'realm-attach', id: foreignRealm });
  expect(baselineTarget('realm.attach', `zone:edit:${zone}`)).toBeNull();
  expect(baselineTarget('realm.attach', 'realm:attach:not-a-realm')).toBeNull();
  const graph = (active: boolean) => ({ async query() { return { boolean: active }; } });
  const client = (granted: boolean) => ({ async query(_sql: string, values?: unknown[]) {
    expect(values).toEqual([actor, `governance:realm:${foreignRealm}`]);
    return { rowCount: granted ? 1 : 0, rows: [] }; } }) as never;
  expect(await realmAttachAllowed(client(true), graph(true), actor, foreignRealm)).toBe(true);
  expect(await realmAttachAllowed(client(false), graph(true), actor, foreignRealm)).toBe(false);
  expect(await realmAttachAllowed(client(true), graph(false), actor, foreignRealm)).toBe(false);
  expect(await realmAttachAllowed(client(true), undefined, actor, foreignRealm)).toBe(false);
});
