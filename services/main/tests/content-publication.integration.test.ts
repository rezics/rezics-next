import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentConflict, ContentCore, type PublicationPreparation,
  type VariantIdentity } from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { buildPinnedContentPublicationUpdate, contentPublicationDecisionIri, contentPublicationDigest,
  publishPinnedContent, reconcilePinnedContentPublication, ContentPublicationConflict,
  ContentPublicationProfileUnavailable, StaleContentOwnerEpoch, StaleGraphReceiptEpoch,
  type PublishPinnedContentInput } from '../src/modules/content-publication/publish.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

/** Simulates only the trusted graph receipt reader, never Jena validation/execution. */
class ReceiptReader extends FusekiClient {
  private receiptRows: SparqlResult['results'] = { bindings: [] };
  constructor() { super('http://localhost:1/rezics'); }
  override async query(): Promise<SparqlResult> { return { results: this.receiptRows }; }
  override async commandHealth() { return { moduleVersion: '0.5.20',
    instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false, profiles: {} }; }

  record(admission: RegisteredAdmission, input: PublishPinnedContentInput,
    preparation: PublicationPreparation, outcome: 'active' | 'rejected',
    change: { revisionId?: string; graphEpoch?: string } = {}): void {
    this.receiptRows = { bindings: [{
      outcome: uri(`https://rezics.com/vocab/${outcome === 'active' ? 'Succeeded' : 'Cancelled'}`),
      ...(outcome === 'rejected' ? { reason: uri('https://rezics.com/vocab/StaleHead') } : {}),
      digest: literal(contentPublicationDigest(input)), admissionId: literal(admission.id),
      authorityEpoch: literal(admission.authorityEpoch), scope: literal(admission.scope),
      preparation: literal(input.preparationId),
      revision: uri(`urn:rezics:content:revision:${change.revisionId ?? input.revisionId}`),
      variant: uri(input.variantId), resource: uri(input.resourceId),
      byteDigest: literal(input.expectedDigest),
      contentEpoch: literal(preparation.position.dataEpoch),
      contentSequence: literal(preparation.position.sequence),
      expectedHead: uri(input.expectedPublicationHead ?? 'urn:rezics:none'),
      ...(outcome === 'active' ? { decision: uri(contentPublicationDecisionIri(admission.id)) } : {}),
      graphEpoch: literal(change.graphEpoch ?? 'graph-epoch-a'), graphSequence: literal('7'),
    }] };
  }
}

function admission(input: PublishPinnedContentInput): RegisteredAdmission {
  return { id: randomUUID(), principalId: randomUUID(), actingSubject: `https://rezics.com/id/${randomUUID()}`,
    scope: `content:publish:${input.variantId}`, action: 'content.publish',
    idempotencyKey: `publish-${randomUUID()}`, requestDigest: contentPublicationDigest(input),
    authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'registered', dispatchEligible: true, replayed: false };
}

test('WORK10: partial Content pin and exact graph receipt reconciliation', async () => {
  const state = join(root, '.temp', `content-publication-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 8 });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const resourceId = `https://rezics.com/id/${randomUUID()}`;
    let ordinal = 0;
    async function saved() {
      const variant: VariantIdentity = { id: `urn:rezics:variant:${++ordinal}`, resourceId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' };
      const result = await content.saveDraft({ operationId: `save-${randomUUID()}`, variant,
        expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
        provenance: { author: 'test' }, serializedJson: '{"body":"Exact publication body"}' });
      if (!result.revisionId) throw new Error('save failed');
      const exact = (await content.readExactBatch([result.revisionId], async (ids) => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('saved body unavailable');
      const input: PublishPinnedContentInput = { preparationId: `publish-${randomUUID()}`,
        revisionId: result.revisionId, expectedDigest: exact.reference.byteDigest,
        expectedContentEpoch: result.position.dataEpoch, resourceId, variantId: variant.id,
        expectedPublicationHead: null };
      return { variant, result, input };
    }
    function environment(fuseki: FusekiClient): WorkActivationEnvironment {
      return { fuseki, lineage: { dataEpoch: 'graph-epoch-a', routingEpoch: 'routing-a' },
        objectDirectory: join(state, 'objects') };
    }
    async function preparationStatus(operationId: string) {
      return (await pool.query('SELECT status, pin_active FROM content.publication_preparation WHERE operation_id = $1',
        [operationId])).rows[0] as { status: string; pin_active: boolean } | undefined;
    }
    async function prepare(input: PublishPinnedContentInput) {
      return content.preparePublication(input.preparationId, input.revisionId, input.expectedDigest, true);
    }

    const first = await saved();
    const firstAdmission = admission(first.input);
    const firstPin = await prepare(first.input);
    const reader = new ReceiptReader();
    // No graph receipt after a lost/ambiguous response is not a terminal outcome.
    expect((await reconcilePinnedContentPublication(environment(reader), content, firstAdmission, first.input)).status).toBe('pending');
    expect(await preparationStatus(first.input.preparationId)).toMatchObject({ status: 'pending', pin_active: true });
    const update = buildPinnedContentPublicationUpdate(environment(reader), firstAdmission, first.input, firstPin);
    expect(update).toContain(`rv:contentRevision <urn:rezics:content:revision:${first.input.revisionId}>`);
    expect(update).toContain('FILTER(COALESCE(?prior, <urn:rezics:none>) = <urn:rezics:none>)');
    expect(update).toContain(`rv:ownerDataEpoch "${first.input.expectedContentEpoch}"`);
    expect(update).toContain('rv:routingEpoch "routing-a"');
    // A committed receipt remains authoritative even when its HTTP response was lost.
    reader.record(firstAdmission, first.input, firstPin, 'active');
    expect((await reconcilePinnedContentPublication(environment(reader), content, firstAdmission, first.input)).status).toBe('active');
    expect(await preparationStatus(first.input.preparationId)).toMatchObject({ status: 'active', pin_active: true });
    expect((await reconcilePinnedContentPublication(environment(reader), content, firstAdmission, first.input)).replayed).toBe(true);

    const stale = await saved();
    await content.saveDraft({ operationId: `save-${randomUUID()}`, variant: stale.variant,
      expectedHead: stale.result.revisionId, model: 'content-shape-v1', sourceRevision: null,
      provenance: { author: 'test' }, serializedJson: '{"body":"Newer body"}' });
    await expect(prepare(stale.input)).rejects.toBeInstanceOf(ContentConflict);
    expect(await preparationStatus(stale.input.preparationId)).toBeUndefined();

    const wrongEpoch = await saved();
    const wrongEpochPin = await prepare(wrongEpoch.input);
    wrongEpoch.input.expectedContentEpoch = randomUUID();
    const wrongEpochAdmission = admission(wrongEpoch.input);
    await expect(reconcilePinnedContentPublication(environment(new ReceiptReader()), content,
      wrongEpochAdmission, wrongEpoch.input)).rejects.toBeInstanceOf(StaleContentOwnerEpoch);
    expect(wrongEpochPin.pinActive).toBe(true);

    const staleOwnerAtSettle = await saved();
    await prepare(staleOwnerAtSettle.input);
    await expect(content.settlePublication(`settle-${randomUUID()}`,
      staleOwnerAtSettle.input.preparationId, { outcome: 'active',
        revisionId: staleOwnerAtSettle.input.revisionId, receipt: 'urn:rezics:receipt:test',
        dataEpoch: 'graph-epoch-a', sequence: '1' }, randomUUID())).rejects.toBeInstanceOf(ContentConflict);
    expect(await preparationStatus(staleOwnerAtSettle.input.preparationId)).toMatchObject({ status: 'pending', pin_active: true });

    const staleOwnerBeforePin = await saved();
    await expect(content.preparePublication(staleOwnerBeforePin.input.preparationId,
      staleOwnerBeforePin.input.revisionId, staleOwnerBeforePin.input.expectedDigest,
      true, randomUUID())).rejects.toBeInstanceOf(ContentConflict);
    expect(await preparationStatus(staleOwnerBeforePin.input.preparationId)).toBeUndefined();

    const oldGraph = await saved();
    const oldGraphPin = await prepare(oldGraph.input);
    const oldGraphAdmission = admission(oldGraph.input);
    const oldGraphReader = new ReceiptReader();
    oldGraphReader.record(oldGraphAdmission, oldGraph.input, oldGraphPin, 'active', { graphEpoch: 'old-epoch' });
    await expect(reconcilePinnedContentPublication(environment(oldGraphReader), content,
      oldGraphAdmission, oldGraph.input)).rejects.toBeInstanceOf(StaleGraphReceiptEpoch);
    expect(await preparationStatus(oldGraph.input.preparationId)).toMatchObject({ status: 'pending', pin_active: true });

    const wrongProof = await saved();
    const wrongProofPin = await prepare(wrongProof.input);
    const wrongProofAdmission = admission(wrongProof.input);
    const wrongProofReader = new ReceiptReader();
    wrongProofReader.record(wrongProofAdmission, wrongProof.input, wrongProofPin, 'active', { revisionId: randomUUID() });
    await expect(reconcilePinnedContentPublication(environment(wrongProofReader), content,
      wrongProofAdmission, wrongProof.input)).rejects.toBeInstanceOf(ContentPublicationConflict);
    expect(await preparationStatus(wrongProof.input.preparationId)).toMatchObject({ status: 'pending', pin_active: true });

    const rejected = await saved();
    const rejectedPin = await prepare(rejected.input);
    const rejectedAdmission = admission(rejected.input);
    const rejectedReader = new ReceiptReader();
    rejectedReader.record(rejectedAdmission, rejected.input, rejectedPin, 'rejected');
    expect((await reconcilePinnedContentPublication(environment(rejectedReader), content,
      rejectedAdmission, rejected.input)).status).toBe('rejected');
    expect(await preparationStatus(rejected.input.preparationId)).toMatchObject({ status: 'rejected', pin_active: false });
    expect((await content.readExactBatch([rejected.input.revisionId], async (ids) => new Set(ids)))[0]?.status).toBe('available');

    const unavailable = await saved();
    const unavailableAdmission = admission(unavailable.input);
    await expect(publishPinnedContent(environment(new ReceiptReader()), content,
      unavailableAdmission, unavailable.input)).rejects.toBeInstanceOf(ContentPublicationProfileUnavailable);
    expect(await preparationStatus(unavailable.input.preparationId)).toBeUndefined();
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 30_000);
