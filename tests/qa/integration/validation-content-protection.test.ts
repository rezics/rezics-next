import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore, type VariantIdentity } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ContentProtectionStore, type ProtectionChangeInput }
  from '../../../services/main/src/modules/protection/content-store.ts';
import { PROTECTION_RULE } from '../../../services/main/src/modules/protection/schema.ts';
import { ratingAccount } from '../support/rating-account.ts';

const nativeId = () => `https://rezics.com/id/${randomUUID()}`;

function barrier() {
  let entered!: () => void, release!: () => void;
  return { ready: new Promise<void>(resolve => { entered = resolve; }),
    waiting: new Promise<void>(resolve => { release = resolve; }),
    entered: () => entered(), release: () => release() };
}

test('MODEL18/MODEL23: Content draft and protection serialize an explicitly absent protection head', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const apps = Bun.env as Record<string, string>;
  const account = await ratingAccount(apps, 'openid content:protect');
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const owner = new ContentProtectionStore(contentPool);
    const actor = nativeId();
    const principal = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
      [principal, account.issuer, account.a.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
    let hook: ((input: ProtectionChangeInput) => Promise<void>) | null = null;
    const store = new Proxy(owner, { get(target, property) {
      if (property === 'changeProtection') return async (input: ProtectionChangeInput) => {
        const selected = hook; hook = null;
        if (selected) await selected(input);
        return target.changeProtection(input);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as ContentProtectionStore;
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    const access = new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY);
    const app = createMainApp(fuseki, { environment: { fuseki,
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
      objectDirectory: resolve('.temp', `validation-content-${randomUUID()}`) },
    account: account.verifier, access, editorialProtection: store });
    const seed = async () => {
      const resourceId = nativeId();
      const variant: VariantIdentity = { id: `urn:rezics:variant:${randomUUID()}`, resourceId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' };
      const initial = (await content.saveDraft({ operationId: `seed-${randomUUID()}`, variant, expectedHead: null,
        model: 'content-shape-v1', sourceRevision: null, provenance: { editor: 'fixture' },
        serializedJson: JSON.stringify({ body: 'Original synopsis' }) })).revisionId!;
      const scope = `content:protect:${resourceId}`;
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'content.protection.confirm',now() + interval '1 hour')`,
      [randomUUID(), principal, actor]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,'content.protection.confirm',now() + interval '1 hour')`,
      [randomUUID(), actor, scope]);
      const protect = () => app.handle(new Request('http://main.local/v1/editorial-protections', {
        method: 'POST', headers: { authorization: `Bearer ${account.tokenA}`,
          'idempotency-key': randomUUID(), 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'content-draft-protection-v1', resourceId, variantId: variant.id,
          action: 'confirm', actingSubject: actor, expectedContentHead: initial, expectedProtectionHead: null,
          expectedRuleRevision: PROTECTION_RULE, reason: 'Review exact draft', evidence: [] }),
      }));
      const edit = () => content.saveDraft({ operationId: `edit-${randomUUID()}`, variant,
        expectedHead: initial, model: 'content-shape-v1', sourceRevision: null,
        provenance: { editor: 'fixture' }, serializedJson: JSON.stringify({ body: 'Prepared edit' }) });
      return { variant, initial, protect, edit };
    };

    const editFirst = await seed();
    const heldProtection = barrier();
    hook = async () => { heldProtection.entered(); await heldProtection.waiting; };
    const pendingProtection = editFirst.protect();
    await Promise.race([heldProtection.ready, Bun.sleep(10_000).then(() => {
      throw new Error('Content protection did not reach the command barrier');
    })]);
    const edit = await editFirst.edit();
    heldProtection.release();
    const rejected = await pendingProtection;
    expect(rejected.status).toBe(409);
    const rejectedBody = await rejected.json() as { code: string; operation: string };
    expect(rejectedBody).toMatchObject({ code: 'stale_content' });
    expect((await contentPool.query<{ outcome: string; reason: string | null }>(
      'SELECT outcome,reason FROM content.receipt WHERE operation_id = $1', [rejectedBody.operation])).rows)
      .toEqual([{ outcome: 'stale_head', reason: 'stale_content' }]);
    expect((await contentPool.query<{ event_type: string }>(
      'SELECT event_type FROM content.outbox WHERE operation_id = $1', [rejectedBody.operation])).rows)
      .toEqual([{ event_type: 'content.protection.rejected' }]);
    expect((await owner.editorialStates([editFirst.variant.id]))[0]).toMatchObject({
      contentHead: edit.revisionId, protection: null });

    const protectionFirst = await seed();
    const heldEdit = barrier();
    const pendingEdit = (async () => { heldEdit.entered(); await heldEdit.waiting; return protectionFirst.edit(); })();
    await heldEdit.ready;
    const protectedWrite = await protectionFirst.protect();
    expect(protectedWrite.status).toBe(201);
    const receipt = await protectedWrite.json() as { operation: string; value: { id: string } };
    heldEdit.release();
    await expect(pendingEdit).rejects.toMatchObject({ constraint: 'variant_correction_required' });
    expect((await owner.editorialStates([protectionFirst.variant.id]))[0]).toMatchObject({
      contentHead: protectionFirst.initial, protection: { id: receipt.value.id } });
    const rows = (await contentPool.query<{ outcome: string; reason: string | null }>(
      'SELECT outcome,reason FROM content.receipt WHERE operation_id = $1', [receipt.operation])).rows;
    expect(rows).toEqual([{ outcome: 'succeeded', reason: null }]);
  } finally { await Promise.all([contentPool.end(), accessPool.end(), account.close()]); }
}, 180_000);
