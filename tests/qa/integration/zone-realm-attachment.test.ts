import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { startHomeStack } from './feed-read-support.ts';
import { AdmissionDenied, AdmissionExpired } from '../../../services/main/src/modules/access/admission.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { readZoneConfiguration, readZoneRevisionConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

type Home = Awaited<ReturnType<typeof startHomeStack>>;
const short = (iriValue: string) => iriValue.slice(-36);

/** A steward with a Zone-only Space and a Realm in another Space, plus an outsider
 * who owns a Zone of their own but stewards nothing. Every record is written
 * through the public API; only grant revocation and expiry touch Access rows. */
async function arrange(home: Home) {
  const { stack, call, json } = home;
  const steward = await home.provision('Realm steward', home.author.token);
  const outsider = await home.provision('Zone owner', home.reader.token);
  const stewardPrincipal = { ...home.author.principal, emailVerified: true };
  const admin = new AccessRealmManagement(stack.accessPool);
  const realmIn = async () => {
    const created = await json<{ realm: string; space: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: `Realm ${randomUUID().slice(0, 8)}`, capabilities: ['realm'],
      actingSubject: steward }, home.author.token), 201);
    await admin.initialize(stewardPrincipal, created.realm, steward, stack.env);
    return created;
  };
  const zoneIn = async (agent: string, token: string) => json<{ space: string; zone: string;
    navigationRevision: string; zoneRevision: string }>(await call('POST', '/v1/spaces', {
    profile: 'space-zone-v1', name: `Site ${randomUUID().slice(0, 8)}`, language: 'en',
    handle: `site-${randomUUID().slice(0, 12)}`, capabilities: ['zone'], actingSubject: agent,
    visibility: 'public', listing: 'listed' }, token), 201);
  const configure = (zone: string, expectedHead: string, patch: object, agent: string, token: string) =>
    call('PUT', `/v1/zones/${short(zone)}/configuration`, { expectedHead, actingSubject: agent, ...patch }, token);
  const head = async (zone: string) => (await readZoneConfiguration(stack.env, zone)).revision;
  const attach = async (zone: string, realm: string) => json<{ revision: string }>(
    await configure(zone, await head(zone), { defaultRealm: realm }, steward, home.author.token));
  const withdraw = (zone: string, realm: string, agent = steward, token = home.author.token) =>
    call('POST', `/v1/zones/${short(zone)}/realm-attachment-withdrawals`, { realm, actingSubject: agent }, token);
  const publicRealm = async (zone: string) => ({
    routes: (await json<{ realm: string | null }>(await call('GET', `/v1/zones/${short(zone)}/routes?path=%2F`))).realm,
    presentation: (await json<{ realm: string | null }>(await call('GET', `/v1/zones/${short(zone)}/presentation`))).realm,
  });
  const editorRealm = async (zone: string) => (await json<{ configuration: { defaultRealm?: string } }>(
    await call('GET', `/v1/zones/${short(zone)}/configuration?actingSubject=${encodeURIComponent(steward)}`,
      undefined, home.author.token))).configuration.defaultRealm;
  /** Publish the Zone's home page; public readers see a Zone only through its published cut. */
  const publisher = async (site: { zone: string; navigationRevision: string }) => {
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const saved = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      await call('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: site.zone, variantId,
        expectedHead: null, document: fromPlainText('Home', 'blocks'), language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr', actingSubject: steward }, home.author.token), 201);
    const pages = [{ page: site.zone, variantId, revisionId: saved.revisionId, byteDigest: saved.byteDigest,
      contentEpoch: saved.sourcePosition.dataEpoch }];
    const body = async () => ({ routesRevision: site.navigationRevision,
      navigationRevision: site.navigationRevision, pages, expectedHead: await head(site.zone),
      actingSubject: steward });
    const run = async () => json<{ revision: string; themeRevision: string }>(await call('POST',
      `/v1/zones/${short(site.zone)}/site-publications`, await body(), home.author.token), 201);
    return Object.assign(run, { body });
  };
  return { steward, outsider, stewardPrincipal, realmIn, zoneIn, configure, head, attach, withdraw, publicRealm,
    editorRealm, publisher };
}

test('a Zone attaches a Realm from another Space only with both authorities, and either side ends it at once', async () => {
  const home = await startHomeStack('zone-realm-attachment', { projectionStart: 'current' });
  try {
    const { call, json } = home;
    const a = await arrange(home);
    const realm = await a.realmIn();
    const site = await a.zoneIn(a.steward, home.author.token);
    const rival = await a.zoneIn(a.outsider, home.reader.token);

    // Refusals read alike: a missing Realm, a Realm the owner cannot steward,
    // and one in another Space the owner holds no realm.attach on.
    const missing = `https://rezics.com/id/${randomUUID()}`;
    const refusals = [] as { status: number; body: unknown }[];
    for (const target of [missing, realm.realm]) {
      const response = await a.configure(rival.zone, rival.zoneRevision, { defaultRealm: target }, a.outsider, home.reader.token);
      refusals.push({ status: response.status, body: await response.json() });
      expect(JSON.stringify(refusals.at(-1)!.body)).not.toContain(target);
    }
    expect(refusals[0]).toEqual(refusals[1]!);
    expect(refusals[0]!.status).toBe(400);
    expect(refusals[0]!.body).toMatchObject({ title: 'default Realm is unavailable' });
    expect(await a.publicRealm(rival.zone)).toEqual({ routes: null, presentation: null });

    // A Realm in the Zone's own Space keeps today's rule.
    const own = await json<{ realm: string; space: string; zone?: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Own Realm', capabilities: ['realm'], actingSubject: a.outsider }, home.reader.token), 201);
    expect(own.realm).toBeString();

    // Both authorities hold: the attachment is made and every read honours it.
    const publish = await a.publisher(site);
    await a.attach(site.zone, realm.realm);
    expect(await a.editorRealm(site.zone)).toBe(realm.realm);
    // Public readers see the draft only once a bundle is published.
    expect(await a.publicRealm(site.zone)).toEqual({ routes: null, presentation: null });
    await publish();
    expect(await a.publicRealm(site.zone)).toEqual({ routes: realm.realm, presentation: realm.realm });
    // Re-submitting the attached Realm keeps its record as granted.
    await json(await a.configure(site.zone, await a.head(site.zone), { defaultRealm: realm.realm },
      a.steward, home.author.token));
    expect(await a.publicRealm(site.zone)).toEqual({ routes: realm.realm, presentation: realm.realm });
    const unrelated = await json<{ revision: string }>(await a.configure(site.zone, await a.head(site.zone),
      { name: 'Renamed site', language: 'en' }, a.steward, home.author.token));
    expect(await a.publicRealm(site.zone)).toEqual({ routes: realm.realm, presentation: realm.realm });

    // A steward withdraws the grant; no Zone authority is involved.
    expect((await a.withdraw(site.zone, realm.realm, a.outsider, home.reader.token)).status).toBe(403);
    expect(await a.publicRealm(site.zone)).toEqual({ routes: realm.realm, presentation: realm.realm });
    const key = randomUUID();
    const body = { realm: realm.realm, actingSubject: a.steward };
    const withdrawn = await json<{ replayed: boolean; receipt: string }>(
      await call('POST', `/v1/zones/${short(site.zone)}/realm-attachment-withdrawals`, body, home.author.token, key));
    expect(withdrawn.replayed).toBe(false);
    expect(await json(await call('POST', `/v1/zones/${short(site.zone)}/realm-attachment-withdrawals`, body,
      home.author.token, key))).toMatchObject({ replayed: true, receipt: withdrawn.receipt });
    expect(await a.publicRealm(site.zone)).toEqual({ routes: null, presentation: null });
    expect(await a.editorRealm(site.zone)).toBeUndefined();
    // Withdrawing what is already gone changes nothing.
    expect((await a.withdraw(site.zone, realm.realm)).status).toBe(404);
    expect(await a.head(site.zone)).toBe(unrelated.revision);

    // Re-attaching is a new grant; the Zone editor then removes it on their side.
    const again = await a.attach(site.zone, realm.realm);
    expect(await a.publicRealm(site.zone)).toEqual({ routes: realm.realm, presentation: realm.realm });
    await json(await a.configure(site.zone, again.revision, { defaultRealm: null }, a.steward, home.author.token));
    expect(await a.publicRealm(site.zone)).toEqual({ routes: null, presentation: null });
    expect(await a.editorRealm(site.zone)).toBeUndefined();
    expect((await a.withdraw(site.zone, realm.realm)).status).toBe(404);
    // The relay consumes the withdrawal's owner event.
    const batches = await home.projectRelay();
    expect(batches.length).toBeGreaterThan(0);
  } finally { await home.stop(); }
}, 180_000);

test('losing realm.attach before the edit is refused like a missing Realm and writes no link', async () => {
  const home = await startHomeStack('zone-realm-attachment-lost', { projectionStart: 'current' });
  try {
    const a = await arrange(home);
    const realm = await a.realmIn();
    const site = await a.zoneIn(a.steward, home.author.token);
    await home.stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE scope_id = $1 AND recipient_subject = $2`, [`governance:realm:${realm.realm}`, a.steward]);
    const response = await a.configure(site.zone, site.zoneRevision, { defaultRealm: realm.realm }, a.steward, home.author.token);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ title: 'default Realm is unavailable' });
    expect(await a.publicRealm(site.zone)).toEqual({ routes: null, presentation: null });
    expect(await a.head(site.zone)).toBe(site.zoneRevision);
  } finally { await home.stop(); }
}, 120_000);

test('a realm.attach grant revoked or expired between register and claim is refused', async () => {
  const home = await startHomeStack('zone-realm-attachment-claim', { projectionStart: 'current' });
  try {
    const { stack } = home;
    const a = await arrange(home);
    const request = (realm: string) => ({ principal: a.stewardPrincipal, actingSubject: a.steward,
      scope: `realm:attach:${realm}`, action: 'realm.attach', idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    const grants = (realm: string) => [`governance:realm:${realm}`, a.steward];
    const refused = (claim: Promise<unknown>) => claim.then(() => null, error => error);

    const revoked = (await a.realmIn()).realm;
    const first = await stack.access.register(request(revoked));
    expect(first.dispatchEligible).toBe(true);
    await stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE scope_id = $1 AND recipient_subject = $2`, grants(revoked));
    expect(await refused(stack.access.claim(first.id, first.requestDigest, a.stewardPrincipal))).toBeInstanceOf(AdmissionDenied);

    const expiring = (await a.realmIn()).realm;
    await stack.accessPool.query(`UPDATE access.permission_grant SET valid_until = clock_timestamp() + interval '1500 ms'
      WHERE scope_id = $1 AND recipient_subject = $2`, grants(expiring));
    const second = await stack.access.register(request(expiring));
    expect(second.dispatchEligible).toBe(true);
    await Bun.sleep(1800);
    const error = await refused(stack.access.claim(second.id, second.requestDigest, a.stewardPrincipal));
    expect(error instanceof AdmissionDenied || error instanceof AdmissionExpired).toBe(true);
  } finally { await home.stop(); }
}, 120_000);

test('a publish after the attachment ends binds no Realm', async () => {
  const home = await startHomeStack('zone-realm-attachment-publish', { projectionStart: 'current' });
  try {
    const { stack } = home;
    const a = await arrange(home);
    const realm = await a.realmIn();
    const site = await a.zoneIn(a.steward, home.author.token);
    const publish = await a.publisher(site);
    const bound = async (themeRevision: string) => (await readZoneRevisionConfiguration(stack.env,
      await readZoneConfiguration(stack.env, site.zone), themeRevision)).configuration.defaultRealm;

    await a.attach(site.zone, realm.realm);
    const withRealm = await publish();
    expect(await bound(withRealm.themeRevision)).toBe(realm.realm);
    expect(await a.publicRealm(site.zone)).toEqual({ routes: realm.realm, presentation: realm.realm });
    const withdrawal = await a.withdraw(site.zone, realm.realm);
    expect([withdrawal.status, await withdrawal.text()]).toEqual([200, expect.any(String)]);
    const afterRevocation = await publish();
    expect(await bound(afterRevocation.themeRevision)).toBeUndefined();
    expect(await bound(withRealm.themeRevision)).toBeUndefined();
    expect(await a.publicRealm(site.zone)).toEqual({ routes: null, presentation: null });
    const linked = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(site.zone)} rv:defaultRealm ?realm } }`, 1024);
    expect(linked.boolean).toBe(false);
  } finally { await home.stop(); }
}, 180_000);

test('a withdrawal landing before an edit or publish commits is not undone by it', async () => {
  const home = await startHomeStack('zone-realm-attachment-race', { projectionStart: 'current' });
  try {
    const { stack, call, json } = home;
    const a = await arrange(home);
    const realm = await a.realmIn();
    const site = await a.zoneIn(a.steward, home.author.token);
    const publish = await a.publisher(site);
    const linked = async () => (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(site.zone)} rv:defaultRealm ?realm } }`, 1024)).boolean;
    const noRealmAnywhere = async () => {
      expect(await linked()).toBe(false);
      expect(await a.editorRealm(site.zone)).toBeUndefined();
      expect(await a.publicRealm(site.zone)).toEqual({ routes: null, presentation: null });
    };
    // The steward withdraws after the editor has read the Zone and before the edit reaches the graph.
    const withdrawBefore = (marker: string) => {
      const original = stack.env.fuseki;
      let fired = false;
      stack.env.fuseki = new Proxy(original, { get(target, property) {
        if (property === 'commandWithReceipt') return async (...args: Parameters<typeof target.commandWithReceipt>) => {
          if (!fired && args[0].update.includes(marker)) {
            fired = true;
            expect((await a.withdraw(site.zone, realm.realm)).status).toBe(200);
          }
          return target.commandWithReceipt(...args);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return { fired: () => fired, restore: () => { stack.env.fuseki = original; } };
    };

    await a.attach(site.zone, realm.realm);
    await publish();
    const edit = withdrawBefore('rv:zoneOperation rv:ZoneConfigure');
    const stale = await a.configure(site.zone, await a.head(site.zone), { name: 'Raced rename', language: 'en' },
      a.steward, home.author.token);
    edit.restore();
    expect(edit.fired()).toBe(true);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale_zone_head' });
    await noRealmAnywhere();
    // The same edit, retried after the withdrawal, commits without the Realm.
    await json(await a.configure(site.zone, await a.head(site.zone), { name: 'Raced rename', language: 'en' },
      a.steward, home.author.token));
    await noRealmAnywhere();

    // A publish racing a withdrawal loses the same way and binds no Realm.
    await a.attach(site.zone, realm.realm);
    const racing = withdrawBefore('rv:sitePublicationRevision');
    const lost = await call('POST', `/v1/zones/${short(site.zone)}/site-publications`, await publish.body(), home.author.token);
    racing.restore();
    expect(racing.fired()).toBe(true);
    expect(lost.status).toBe(409);
    await noRealmAnywhere();
    await publish();
    await noRealmAnywhere();
    const ownerEvents = await home.projectRelay();
    expect(ownerEvents.length).toBeGreaterThan(0);
  } finally { await home.stop(); }
}, 180_000);

test('a steward lists attached Zones page by page; anyone else gets the missing Realm, at the same cost for 1 and 50', async () => {
  const home = await startHomeStack('zone-realm-attachment-list', { projectionStart: 'current' });
  try {
    const { stack, call } = home;
    const a = await arrange(home);
    const realm = await a.realmIn();
    const site = await a.zoneIn(a.steward, home.author.token);
    await a.attach(site.zone, realm.realm);
    const listPath = (id: string, tokenSubject?: string, limit?: number) => {
      const search = new URLSearchParams();
      if (tokenSubject) search.set('actingSubject', tokenSubject);
      if (limit) search.set('limit', String(limit));
      const query = search.toString();
      return `/v1/realms/${short(id)}/zone-attachments${query ? `?${query}` : ''}`;
    };
    const read = async (id: string, token?: string, subject?: string, limit?: number) => {
      const response = await call('GET', listPath(id, subject, limit), undefined, token);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const missing = randomUUID();
    const [anonymous, outsider, absent] = await Promise.all([
      read(realm.realm),
      read(realm.realm, home.reader.token, a.outsider),
      read(missing, home.author.token, a.steward),
    ]);
    expect(anonymous.status).toBe(404);
    expect(anonymous.body).toEqual(outsider.body);
    expect(anonymous.body).toEqual(absent.body);
    expect(anonymous.body).toMatchObject({ status: 404, code: 'realm_unavailable', title: 'Realm is unavailable' });
    const hidden = JSON.stringify([anonymous.body, outsider.body, absent.body]);
    expect(hidden).not.toContain(realm.realm);
    expect(hidden).not.toContain(missing);

    const empty = await a.realmIn();
    expect(await read(empty.realm, home.author.token, a.steward)).toMatchObject({ status: 200, body: { items: [] } });

    const listed = async (limit = 24) => read(realm.realm, home.author.token, a.steward, limit);
    await listed();
    const before = stack.fuseki.queries;
    const one = await listed();
    const atOne = stack.fuseki.queries - before;
    expect(one.status).toBe(200);
    const page = one.body as { items: { zone: string; name: string | null; attachedAt: string | null;
      address: { prefix: string }; withdraw: { method: string; path: string } }[];
      next: string | null; cost: { graphReads: number } };
    expect(page.items.map(item => item.zone)).toContain(site.zone);
    const row = page.items.find(item => item.zone === site.zone)!;
    expect(row.name).toEqual(expect.any(String));
    expect(row.name!.length).toBeGreaterThan(0);
    expect(row.attachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.address.prefix).toBe('/z/');
    expect(row.withdraw).toEqual({ method: 'POST', path: `/v1/zones/${short(site.zone)}/realm-attachment-withdrawals` });
    expect(page.cost.graphReads).toBe(1);

    const decoy = `https://rezics.com/id/${randomUUID()}`;
    const extras = Array.from({ length: 49 }, (_, index) => {
      const hex = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
      return { zone: `https://rezics.com/id/${randomUUID()}`, space: `https://rezics.com/id/${randomUUID()}`,
        receipt: `urn:rezics:receipt:${hex}`, label: `Extra ${index}` };
    });
    const current = [
      `${iri(decoy)} a rv:Zone ; rv:defaultRealm ${iri(realm.realm)} ; rv:space ${iri(site.space)} .`,
      ...extras.map(item => `${iri(item.zone)} a rv:Zone ; rv:defaultRealm ${iri(realm.realm)} ;
        rv:realmAttachment ${iri(item.receipt)} ; rv:space ${iri(item.space)} ;
        <http://www.w3.org/2000/01/rdf-schema#label> ${JSON.stringify(item.label)}@en .`),
    ].join('\n');
    const receipts = extras.map(item => `${iri(item.receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:realmAttachedAt "2026-10-08T03:04:05.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`).join('\n');
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${current} }
      GRAPH ${iri(GRAPHS.receipts)} { ${receipts} } }`);
    const mid = stack.fuseki.queries;
    const fifty = await listed();
    expect(stack.fuseki.queries - mid).toBe(atOne);
    expect(atOne).toBeGreaterThan(0);
    expect((fifty.body as { cost: { graphReads: number } }).cost.graphReads).toBe(page.cost.graphReads);

    const first = await listed(1);
    const firstPage = first.body as { items: { zone: string }[]; next: string | null };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.next).toMatch(/^v1:https:\/\/rezics\.com\/id\//);
    const secondResponse = await call('GET', `${listPath(realm.realm, a.steward, 1)}&after=${encodeURIComponent(firstPage.next!)}`,
      undefined, home.author.token);
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as { items: { zone: string }[] };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.zone).not.toBe(firstPage.items[0]!.zone);
    const wide = await listed(50);
    const wideItems = (wide.body as { items: { zone: string }[]; next: string | null }).items;
    expect(wideItems).toHaveLength(50);
    expect(wideItems.some(item => item.zone === decoy)).toBe(false);
  } finally { await home.stop(); }
}, 180_000);
