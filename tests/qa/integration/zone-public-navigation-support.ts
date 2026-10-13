import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { fromPlainText } from '@rezics/document';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { changeAdmittedComposition } from '../../../services/main/src/modules/structure/change-admitted.ts';
import type { CompositionOperation } from '../../../services/main/src/modules/structure/change.ts';
import { normalizeStoredMembership } from '../../../services/main/src/modules/structure/membership-normalize.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

interface Draft { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }
interface PageSelection { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string }
interface ChangedNavigation { revision: string; occurrences: string[] }

export async function publicNavigationFixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `zone-public-navigation-${randomUUID()}`),
    'openid agent:create work:create work:edit work:read space:create zone:edit collection:edit semantic:read');
  try {
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try { await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [f.account.a.id]); }
    finally { await accountPool.end(); }
    f.account.tokenA = await f.account.tokenFor(f.account.a);
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    // Earlier fixtures may leave their deliberately changed native projection.
    expect((await normalizeStoredMembership(f.env)).complete).toBe(true);
    const content = new ContentCore(f.pool);
    const app = createMainApp(f.env.fuseki, { environment: f.env, account: f.account.verifier,
      access: f.access, content, contentAuthoring: content,
      governance: { store: f.governance },
      realmAdmin: new AccessRealmManagement(f.accessPool),
      agentProvisioning: new AgentProvisioning(f.accessPool, f.env) });
    const call = (method: string, path: string, body?: object, anonymous = false) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { ...(!anonymous ? { authorization: `Bearer ${f.account.tokenA}` } : {}),
          'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    const { agent: actor } = await f.json<{ agent: string }>(await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Navigation publisher',
    }), 201);
    const grant = async (scope: string, action: string) => grantFixtureAuthority(f.accessPool, {
      scope, requireDispatch: true,
      representations: [{ principalId: f.principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' },
    });
    await grant('space:create:root', 'space.create');
    const created = await f.json<{ space: string; zone: string; navigationRevision: string }>(
      await call('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Long navigation',
        capabilities: ['zone'], visibility: 'public', actingSubject: actor }), 201);
    await grant(`zone:edit:${created.zone}`, 'zone.edit');
    const path = `/v1/zones/${shortId(created.zone)}`;
    const configuration = async () => f.json<{ revision: string; configuration: { navigation: string; homeDocument?: string } }>(
      await call('GET', `${path}/configuration?actingSubject=${encodeURIComponent(actor)}`), 200);
    await f.json(await call('PUT', `${path}/configuration`, {
      expectedHead: (await configuration()).revision, prepareHomeDocument: true, actingSubject: actor,
    }), 200);
    const homeDocument = (await configuration()).configuration.homeDocument!;
    const navigation = (await configuration()).configuration.navigation;
    const collection = nativeId();
    await grant(`collection:edit:${collection}`, 'collection.edit');
    await grant(`semantic:read:${collection}`, 'semantic.read');
    await f.json(await call('POST', '/v1/collections', { collection, name: 'Navigation collection',
      disclosure: 'public', actingSubject: actor }), 201);
    const privateCollection = nativeId();
    await grant(`collection:edit:${privateCollection}`, 'collection.edit');
    await grant(`semantic:read:${privateCollection}`, 'semantic.read');
    await f.json(await call('POST', '/v1/collections', { collection: privateCollection,
      name: 'Private navigation collection', disclosure: 'private', actingSubject: actor }), 201);
    await grant('work:create:root', 'work.create');
    const tail = await f.json<{ work: string; mainVersion: string; workRevision: string }>(
      await call('POST', '/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work',
        title: 'Navigation document', language: 'en', semanticTypes: ['https://schema.org/Recipe'],
        actingSubject: actor }), 201);
    await grant(`work:edit:${tail.work}`, 'work.edit');
    await grant(`work:edit:${tail.work}`, 'recipe.edit');
    await grant(`work:read:${tail.work}`, 'work.read');
    await grant(`work:publish:${tail.work}`, 'work.publish');
    await grant(`work:publish:${tail.work}`, 'work.withdraw-publication');
    const composition = await f.json<{ structure: string; revision: string }>(
      await call('POST', '/v1/compositions', { profile: 'recipe-composition', work: tail.work,
        mainVersion: tail.mainVersion, actingSubject: actor }), 201);
    let tailPublication: string | null = null;
    const publishTail = async () => {
      const result = await f.json<{ publicationDecision: string }>(await call('POST', '/v1/work-publications', {
        profile: 'work-structure-publication-v1', operation: 'publish', work: tail.work, actingSubject: actor,
        expectedWorkHead: tail.workRevision, expectedMainVersion: tail.mainVersion,
        structure: composition.structure, expectedStructureHead: composition.revision,
        expectedPublicationHead: tailPublication, disclosure: 'public', rightsBasis: 'original-contribution',
      }), 201);
      tailPublication = result.publicationDecision;
    };
    await publishTail();
    const targets = [collection, tail.work];
    const changeNavigation = async (expectedHead: string, operations: readonly CompositionOperation[]) => {
      const result = await changeAdmittedComposition(f.env, f.account.verifier, f.access,
        new Request('http://main.local/navigation-fixture', { headers: { authorization: `Bearer ${f.account.tokenA}` } }),
        { structure: navigation, expectedHead, operations, actingSubject: actor, idempotencyKey: randomUUID() });
      if (result.outcome !== 'succeeded' || !result.revision || !result.occurrences) {
        throw new Error('Navigation fixture did not commit its immutable selection');
      }
      return result as ChangedNavigation;
    };
    const save = async (previous?: PageSelection): Promise<PageSelection> => {
      const variantId = previous?.variantId ?? `urn:rezics:variant:${randomUUID()}`;
      const draft = await f.json<Draft>(await call('POST', '/v1/content-drafts', {
        profile: 'content-text-v1', resourceId: homeDocument, variantId,
        expectedHead: previous?.revisionId ?? null, document: fromPlainText(previous ? 'Later private home draft' : 'Published home', 'blocks'),
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor,
      }), 201);
      return { page: homeDocument, variantId, revisionId: draft.revisionId,
        byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch };
    };
    const publish = async (navigationRevision: string, page: PageSelection) => f.json<{ revision: string }>(
      await call('POST', `${path}/site-publications`, {
        expectedHead: (await configuration()).revision,
        routesRevision: navigationRevision, navigationRevision, pages: [page], actingSubject: actor,
      }), 201);
    const presentation = (after?: string) => call('GET', `${path}/presentation${after ? `?after=${encodeURIComponent(after)}` : ''}`,
      undefined, true);
    const disclose = async (resource: string, visibility: 'public' | 'private') => {
      // Withdrawal changes the target's live visibility without changing the Zone selection.
      if (resource === tail.work) {
        if (visibility === 'public') await publishTail();
        else {
          const withdrawn = await f.json<{ publicationDecision: string }>(await call('POST', '/v1/work-publications', {
            profile: 'work-structure-publication-v1', operation: 'withdraw', work: tail.work,
            actingSubject: actor, expectedPublicationHead: tailPublication,
          }), 201);
          tailPublication = withdrawn.publicationDecision;
        }
        return;
      }
      if (resource !== created.space) throw new Error('Navigation fixture visibility target is unknown');
      const settingsPath = `/v1/spaces/${shortId(created.space)}/settings`;
      const current = await f.json<{ generation: string; settings: { listing: 'listed' | 'unlisted' } }>(
        await call('GET', `${settingsPath}?actingSubject=${encodeURIComponent(actor)}`), 200);
      await f.json(await call('PUT', settingsPath, {
        expectedGeneration: current.generation, actingSubject: actor,
        reason: 'Exercise live navigation visibility', settings: { visibility, listing: current.settings.listing },
      }), 201);
    };
    return { ...f, ...created, actor, path, navigation, targets, privateCollection,
      call, changeNavigation, save, publish, presentation, disclose };
  } catch (error) { await f.close(); throw error; }
}
