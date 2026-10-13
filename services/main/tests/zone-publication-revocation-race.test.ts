import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { fromPlainText } from '@rezics/document';
import type { ContentCore, ExactReadResult, PublicationPreparation } from '../../content/src/core.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AdmissionDenied, type AdmissionRequest, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { compositionReceiptIri } from '../src/modules/structure/change.ts';
import { hash, prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { publishZoneSite, ZoneStale, type ZoneSitePublicationInput } from '../src/modules/zone/configuration.ts';
import { ZONE_CONFIG_FORMAT, ZONE_LIMITS, ZONE_PROFILE, zonePublishedPageBinding } from '../src/modules/zone/config-format.ts';

const resource = () => `https://rezics.com/id/${randomUUID()}`;
const cells = (values: Record<string, string>) => Object.fromEntries(Object.entries(values)
  .map(([key, value]) => [key, { type: 'literal' as const, value }]));

/** Only dependency boundaries are controlled: the real site owner creates its
 * pins, checks live authority, writes guarded commands and settles receipts. */
function competingSite() {
  const zone = resource(), homeDocument = resource(), space = resource(), navigation = resource(), actor = resource();
  const navigationRevision = resource(), variantId = `urn:rezics:variant:${randomUUID()}`;
  const initialHead = resource(), initialHome = resource();
  const contentEpoch = randomUUID(), lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
  const objectDirectory = mkdtempSync(join(resolve(import.meta.dir, '../../../.temp'), 'publication-revocation-'));
  const manifest = prepareComponent(objectDirectory, zone, { configuration: {
    format: ZONE_CONFIG_FORMAT, zone, space, navigation, homeDocument, state: 'active', disclosure: 'public',
    budget: { timeMs: ZONE_LIMITS.queryBudgetMs, rows: ZONE_LIMITS.queryBudgetRows }, queryBlocks: [], model: ZONE_PROFILE,
  } }, ZONE_PROFILE);
  const provenance = { kind: 'admitted-original-contribution-v1', rightsBasis: 'original-contribution',
    author: actor, scope: `content:draft:${homeDocument}` };
  function saved(text: string): ExactReadResult & { status: 'available' } {
    const revisionId = randomUUID(), body = { body: text, document: fromPlainText(text, 'blocks') }, serializedJson = JSON.stringify(body);
    return { status: 'available', revisionId, body, serializedJson, reference: {
      owner: 'content', resourceId: homeDocument, variantId, revisionId, format: 'rezics-content-json-v1',
      model: 'content-shape-v1', byteDigest: hash(serializedJson), byteLength: Buffer.byteLength(serializedJson),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      sourceRevision: null, predecessor: null, provenance } };
  }
  const previous = saved('Prior public cut'), retained = saved('Retained rejected saved cut'), competing = saved('Competing public cut');
  const exacts = new Map([previous, retained, competing].map(exact => [exact.revisionId, exact]));
  const admissions = new Map<string, RegisteredAdmission>(), terminals = new Map<string, Record<string, string>>();
  const publications = new Map<string, Record<string, string>>(), pins = new Map<string, PublicationPreparation>();
  const events: string[] = [], nativeAttempts: CommandEnvelope[] = [];
  let head = initialHead, home = initialHome, publicRevision = previous.revisionId, sequence = 1;
  let revoked = false, pause = true;
  let signalPinned!: () => void, releasePin!: () => void;
  const pinned = new Promise<void>(resolvePin => { signalPinned = resolvePin; });
  const pinGate = new Promise<void>(resolveGate => { releasePin = resolveGate; });
  const receiptIn = (query: string) => [...terminals.keys()].find(receipt => query.includes(`<${receipt}>`));
  class PublicationGraph extends FusekiClient {
    constructor() { super('http://publication-race.invalid'); }
    override async commandHealth() {
      return { moduleVersion: 'fixture', instanceId: randomUUID(), publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
        profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, profile]) => [key, profile.sha256])) };
    }
    override async query(query: string): Promise<SparqlResult> {
      if (query.includes('SELECT ?outcome ?reason')) {
        const receipt = receiptIn(query), terminal = receipt && terminals.get(receipt);
        return { results: { bindings: terminal ? [cells(terminal)] : [] } };
      }
      if (query.includes('SELECT ?zone ?revision')) {
        const receipt = receiptIn(query), publication = receipt && publications.get(receipt);
        return { results: { bindings: publication ? [cells(publication)] : [] } };
      }
      if (query.includes('SELECT ?space ?navigation ?head')) return { results: { bindings: [cells({ space, navigation,
        head, manifest: `urn:rezics:sha256:${manifest}`, state: `${RV}Active`, spaceDisclosure: `${RV}Public`,
        homeDocument, homeRevision: home })] } };
      if (query.includes('SELECT DISTINCT ?type ?zone')) return { results: { bindings: [cells({ type: `${RV}ZoneHomeDocument`, zone })] } };
      if (query.includes('SELECT ?admission ?receipt ?digest')) return { results: { bindings: [cells({ admission: randomUUID(),
        receipt: `urn:rezics:receipt:${'a'.repeat(64)}`, digest: 'b'.repeat(64) })] } };
      if (query.includes('ASK')) return { boolean: !query.includes('rv:rejectionKind rv:InvalidProfile') };
      throw new Error(`Unexpected publication query: ${query.slice(0, 150)}`);
    }
    override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
      if (terminals.has(envelope.receipt)) return { status: 'committed' } as CommandResult;
      const admission = [...admissions.values()].find(value => compositionReceiptIri(value.id, 'zone.edit') === envelope.receipt)!;
      const revision = envelope.validations.find(validation => validation.shape === `${ZONE_PROFILE}/revision-shape`)?.focus[0];
      const nextHome = envelope.validations.find(validation => validation.shape === `${ZONE_PROFILE}/home-revision-shape`)?.focus[0];
      if (nextHome) {
        nativeAttempts.push(envelope);
        // Model the graph's compare-and-switch, using the WHERE emitted by the
        // implementation rather than the head supplied to this fixture.
        const where = envelope.update.slice(envelope.update.lastIndexOf('WHERE {'));
        const selectedHead = where.match(/rv:zoneHead <([^>]+)>/)?.[1];
        const selectedHome = where.match(/rv:homeDocumentHead <([^>]+)>/)?.[1];
        expect(selectedHead).toBeDefined();
        expect(selectedHome).toBeDefined();
        if (selectedHead !== head || selectedHome !== home) {
          events.push('stale-switch-refused');
          return { status: 'committed' } as CommandResult;
        }
        const selected = [...exacts.values()].find(exact => envelope.update.includes(
          `rv:contentRevision <urn:rezics:content:revision:${exact.revisionId}>`))!;
        expect(selected).toBeDefined();
        expect(envelope.update).toContain(`rv:byteDigest "${selected.reference.byteDigest}"`);
        head = revision!; home = nextHome; publicRevision = selected.revisionId;
        events.push(`switch:${selected.revisionId}`);
        publications.set(envelope.receipt, { zone, revision: head, routesRevision: navigationRevision, navigationRevision,
          themeRevision: selectedHead!, count: '1', admissionId: admission.id, digest: envelope.digest,
          authorityEpoch: admission.authorityEpoch, scope: admission.scope, dataEpoch: lineage.dataEpoch,
          sequence: String(sequence + 1), binding: zonePublishedPageBinding(head, homeDocument, selected.revisionId),
          page: homeDocument, variant: variantId, contentRevision: `urn:rezics:content:revision:${selected.revisionId}`,
          byteDigest: selected.reference.byteDigest, language: 'en', homeDocument, homeRevision: home });
      } else events.push(`cancel:${admission.id}`);
      terminals.set(envelope.receipt, { outcome: `${RV}${nextHome ? 'Succeeded' : 'Cancelled'}`, digest: envelope.digest,
        admission: admission.id, epoch: admission.authorityEpoch, scope: admission.scope, dataEpoch: lineage.dataEpoch,
        sequence: String(++sequence), ...(nextHome ? { owner: zone, revision: head } : {}) });
      return { status: 'committed' } as CommandResult;
    }
  }
  const environment = { fuseki: new PublicationGraph(), objectDirectory, lineage } as WorkActivationEnvironment;
  const position = { owner: 'content' as const, dataEpoch: contentEpoch, sequence: '3' };
  const content = {
    owningResourceForRevision: async (revision: string) => exacts.has(revision) ? homeDocument : null,
    ownerPosition: async () => position,
    readExactBatch: async (ids: string[]) => ids.map(id => exacts.get(id)),
    preparePublication: async (operationId: string, revisionId: string) => {
      const preparation: PublicationPreparation = { operationId, reference: exacts.get(revisionId)!.reference,
        position, status: 'pending', pinActive: true, replayed: false };
      pins.set(operationId, preparation);
      events.push(`pin:${revisionId}`);
      return preparation;
    },
    readPublicationPreparation: async (id: string) => pins.get(id) ?? null,
    settlePublication: async (_operationId: string, preparationId: string, proof: { outcome: 'active' | 'rejected'; revisionId: string }) => {
      const preparation = pins.get(preparationId)!;
      // The cancellation writer must retain its receipt before dropping a pin.
      const terminal = terminals.get(compositionReceiptIri(preparationId.split(':')[1]!, 'zone.edit'));
      expect(terminal?.outcome).toBe(`${RV}${proof.outcome === 'active' ? 'Succeeded' : 'Cancelled'}`);
      expect(proof.revisionId).toBe(preparation.reference.revisionId);
      const replayed = !preparation.pinActive;
      preparation.pinActive = false; preparation.status = proof.outcome;
      events.push(`settle:${proof.outcome}:${proof.revisionId}`);
      return { status: proof.outcome, pinActive: false, position, replayed };
    },
  } as unknown as ContentCore;
  const principal = (name: string) => ({ issuer: 'https://account.test', subject: name, emailVerified: true });
  const account = { verify: async (request: Request) => principal(request.headers.get('authorization')!) };
  const access = {
    activePrincipalId: async () => randomUUID(),
    register: async (request: AdmissionRequest) => {
      const existing = admissions.get(request.idempotencyKey);
      if (existing) return { ...existing, replayed: true,
        ...(terminals.has(compositionReceiptIri(existing.id, 'zone.edit')) ? { state: 'sealed' as const } : {}) };
      if (revoked && request.principal.subject === 'editor') throw new AdmissionDenied('Editor control revoked');
      const admitted = { ...request, id: randomUUID(), principalId: randomUUID(), authorityEpoch: '1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'registered' as const,
        dispatchEligible: true, replayed: false };
      admissions.set(request.idempotencyKey, admitted); return admitted;
    },
    claim: async (id: string) => ({ ...[...admissions.values()].find(value => value.id === id)!, state: 'claimed' as const }),
    recordGraphOutcome: async () => undefined,
    withOwnerAuthority: async (authority: AdmissionRequest, write: (client: PoolClient) => Promise<unknown>) => {
      expect(authority.scope).toBe(`${authority.action === 'content.publish' ? 'content:publish' : 'zone:edit'}:${zone}`);
      if (revoked && authority.principal.subject === 'editor') {
        events.push('revoked-switch-refused'); throw new AdmissionDenied('Editor control revoked');
      }
      return write({ query: async () => ({ rows: [], rowCount: 1 }) } as unknown as PoolClient);
    },
    withPreservationFence: async <T>(target: string, operation: string, write: () => Promise<T>) => {
      expect(target).toBe(homeDocument);
      // This boundary is after pinAdmittedZonePageContent has returned and
      // released its Content authority lock, before the live switch proof.
      if (pins.get(`content-site-pin:${operation}:${retained.revisionId}`) && pause) {
        pause = false; signalPinned(); await pinGate;
      }
      return { held: false as const, value: await write() };
    },
  } as unknown as Parameters<typeof publishZoneSite>[2];
  const input = (exact: typeof retained, expectedHead = head): ZoneSitePublicationInput => ({ zone, expectedHead,
    actingSubject: actor, idempotencyKey: randomUUID(), routesRevision: navigationRevision, navigationRevision,
    pages: [{ page: homeDocument, variantId, revisionId: exact.revisionId, byteDigest: exact.reference.byteDigest, contentEpoch }] });
  const publish = (body: ZoneSitePublicationInput, name = 'editor') => publishZoneSite(environment, account, access,
    new Request('http://main.test/v1/zone-site-publications', { headers: { authorization: name } }), body, content);
  return { input, publish, pinned, releasePin, retained, competing, provenance, pins, events, nativeAttempts,
    revoke: () => { revoked = true; events.push('revoke'); }, restore: () => { revoked = false; events.push('restore'); },
    current: () => ({ head, home, publicRevision }), initial: { head: initialHead, home: initialHome, publicRevision: previous.revisionId },
    cleanup: () => rmSync(objectDirectory, { recursive: true, force: true }) };
}

for (const revoke of [true, false]) {
  test(`${revoke ? 'revocation' : 'a competing head'} after Content pin refuses the saved cut and preserves retry recovery`, async () => {
    const f = competingSite(), staleBody = f.input(f.retained);
    // Attach a rejection handler immediately so controlled refusal is never an
    // unhandled rejection while the competing request is being observed.
    const pending = f.publish(staleBody).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
      await Promise.race([f.pinned, pending.then(result => { throw new Error(`Publication ended before its pin: ${result.error}`); })]);
      expect(f.current()).toEqual(f.initial);
      expect([...f.pins.values()]).toHaveLength(1);
      expect([...f.pins.values()][0]).toMatchObject({ pinActive: true, status: 'pending', reference: f.retained.reference });
      if (revoke) f.revoke();
      const winnerBody = f.input(f.competing, staleBody.expectedHead);
      const winner = await f.publish(winnerBody, 'surviving-controller');
      expect(winner.replayed).toBe(false);
      expect(winner.pages[0]).toMatchObject({ revisionId: f.competing.revisionId, byteDigest: f.competing.reference.byteDigest });
      const winningCut = f.current();
      expect(winningCut).toMatchObject({ head: winner.revision, home: winner.homeRevision, publicRevision: f.competing.revisionId });
      f.releasePin();
      const refused = await pending;
      expect(refused.value).toBeUndefined();
      expect(refused.error).toBeInstanceOf(revoke ? AdmissionDenied : ZoneStale);
      expect(f.current()).toEqual(winningCut);
      expect(f.nativeAttempts).toHaveLength(revoke ? 1 : 2);
      expect(f.events.indexOf(`pin:${f.retained.revisionId}`)).toBeLessThan(f.events.indexOf(`switch:${f.competing.revisionId}`));
      if (revoke) {
        expect(f.events.indexOf('revoke')).toBeLessThan(f.events.indexOf(`switch:${f.competing.revisionId}`));
        expect(f.events.indexOf(`switch:${f.competing.revisionId}`)).toBeLessThan(f.events.indexOf('revoked-switch-refused'));
      } else expect(f.events.indexOf(`switch:${f.competing.revisionId}`)).toBeLessThan(f.events.indexOf('stale-switch-refused'));
      expect(f.events).not.toContain(`switch:${f.retained.revisionId}`);
      const rejectedPin = [...f.pins.values()].find(pin => pin.reference.revisionId === f.retained.revisionId)!;
      expect(rejectedPin).toMatchObject({ pinActive: false, status: 'rejected', reference: f.retained.reference });
      f.restore();
      await expect(f.publish(staleBody)).rejects.toBeInstanceOf(AdmissionDenied);
      expect(f.current()).toEqual(winningCut);
      expect(f.nativeAttempts).toHaveLength(revoke ? 1 : 2);
      expect(rejectedPin.reference.byteDigest).toBe(hash(f.retained.serializedJson));
      expect(rejectedPin.reference.provenance).toEqual(f.provenance);
      const recoveryBody = f.input(f.retained);
      const recovery = await f.publish(recoveryBody);
      expect(recovery.pages[0]).toMatchObject({ revisionId: f.retained.revisionId, byteDigest: f.retained.reference.byteDigest });
      const recoveredCut = f.current();
      expect(recoveredCut).toMatchObject({ head: recovery.revision, home: recovery.homeRevision, publicRevision: f.retained.revisionId });
      expect(await f.publish(recoveryBody)).toEqual({ ...recovery, replayed: true });
      expect(await f.publish(winnerBody, 'surviving-controller')).toEqual({ ...winner, replayed: true });
      expect(f.current()).toEqual(recoveredCut);
      expect([...f.pins.values()].every(pin => !pin.pinActive)).toBe(true);
      expect(f.nativeAttempts).toHaveLength(revoke ? 2 : 3);
    } finally { f.releasePin(); await pending; f.cleanup(); }
  });
}
