import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { OpenLibraryConversionStore } from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { OpenLibrarySourceGraph } from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { SourceNativeWorkProposalStore, type NativeWorkSourceProposal } from '../../../services/main/src/modules/source/native-work-proposal.ts';
import { SourceNativeWorkAdoptionStore, type NativeWorkSourceAdoption } from '../../../services/main/src/modules/source/native-work-adoption.ts';
import { SourceNativeWorkAttachmentStore } from '../../../services/main/src/modules/source/native-work-attachment.ts';
import { SourceChildCorrespondenceStore } from '../../../services/main/src/modules/source/record-child-correspondence.ts';
import { SourceAuthorCreditStore, type AdoptSourceAuthorCreditInput } from '../../../services/main/src/modules/source/author-credit.ts';
import { sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';

export const shortId = (uri: string) => uri.split('/').at(-1)!;
export const nativeId = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
export const author = (key: string, role: string | null = '/type/author_role') =>
  ({ author: { key }, ...(role === null ? {} : { type: { key: role } }) });

export async function authorCreditFixture(apps: Record<string, string>, objectDirectory: string) {
  const account = await ratingAccount(apps,
    'openid work:create work:edit work:read source:acquire source:convert source:propose source:adopt source:correspond source:read');
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const pool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  await migrateContent(pool);
  const nativeFuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
  let loseCertificate = false;
  let mutate: ((envelope: CommandEnvelope) => CommandEnvelope) | undefined;
  let loseGraphResponse = false;
  const creditCommands: Array<{ bytes: number; focuses: number }> = [];
  const fuseki = new Proxy(nativeFuseki, { get(target, property) {
    if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
      const credit = envelope.update.includes('AuthorCreditAdoptedEvent');
      const changed = credit && mutate ? mutate(envelope) : envelope;
      if (credit) mutate = undefined;
      if (credit) creditCommands.push({ bytes: Buffer.byteLength(JSON.stringify(changed)),
        focuses: changed.validations.reduce((total, entry) => total + entry.focus.length, 0) });
      const result = await target.commandWithReceipt(changed);
      if (credit && loseGraphResponse) { loseGraphResponse = false; throw new Error('lost graph acknowledgement'); }
      return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as FusekiClient;
  const faultPool = new Proxy(pool, { get(target, property) {
    if (property === 'query') return async (query: string, params?: unknown[]) => {
      if (loseCertificate && query.startsWith('INSERT INTO source.author_credit_application')) {
        loseCertificate = false; throw new Error('interrupted before source certificate');
      }
      return target.query(query, params);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
  const env = { fuseki, lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! }, objectDirectory };
  const access = new AccessAdmissionRegistry(accessPool);
  const intake = new SourceIntakeStore(pool), conversions = new OpenLibraryConversionStore(pool, intake);
  const graph = new OpenLibrarySourceGraph(fuseki, env.lineage, conversions);
  const proposals = new SourceNativeWorkProposalStore(pool, graph, conversions);
  const correspondences = new SourceChildCorrespondenceStore(pool, conversions);
  const adoptions = new SourceNativeWorkAdoptionStore(pool, proposals, env, account.verifier, access);
  const credits = new SourceAuthorCreditStore(faultPool, proposals, conversions, correspondences, env, account.verifier, access);
  const principalId = randomUUID(), otherPrincipal = randomUUID(), actor = nativeId();
  await accessPool.query(`INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
    [principalId, account.issuer, account.a.id, otherPrincipal, account.b.id]);
  await accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const grant = async (scope: string, action: string) => {
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
    const id = randomUUID();
    await accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [id, actor, scope, action]);
    return id;
  };
  await grant('work:create:root', 'work.create');
  let source: Record<string, unknown> = {};
  const app = createMainApp(fuseki, { environment: env, account: account.verifier, access,
    sourceIntake: intake, sourceConversions: conversions, sourceGraph: graph, sourceProposals: proposals,
    sourceCorrespondences: correspondences, sourceAdoptions: adoptions, sourceAuthorCredits: credits,
    sourceAttachments: new SourceNativeWorkAttachmentStore(pool, proposals, adoptions, env, access),
    openLibraryFetch: (async () => new Response(JSON.stringify(source), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  const call = (method: string, path: string, body?: object, key = randomUUID(), token = account.tokenA) => app.handle(
    new Request(`http://main.local${path}`, { method, headers: { authorization: `Bearer ${token}`,
      'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    const result = await response.json();
    if (response.status !== status) console.error('author credit fixture response', response.status, result);
    expect(response.status).toBe(status);
    return result as T;
  };
  const propose = async (workId: string, authors: unknown, title = 'Author credit Work') => {
    source = { key: `/works/${workId}`, type: { key: '/type/work' }, title,
      ...(authors === undefined ? {} : { authors }) };
    const capture = await json<{ observation: { observation: string } }>(await call('POST',
      '/v1/sources/acquisitions/open-library/works', { profile: 'open-library-work-acquisition-v1', workId }), 201);
    const converted = await json<{ conversion: { conversion: string; observation: string } }>(await call('POST',
      `/v1/sources/observations/${shortId(capture.observation.observation)}/conversions/open-library-work`,
      { profile: 'open-library-work-map-v1' }), 201);
    const conversion = shortId(converted.conversion.conversion);
    await json(await call('POST', `/v1/sources/conversions/${conversion}/source-graph`, { profile: 'source-open-library-work-v1' }), 200);
    const result = await json<{ proposal: NativeWorkSourceProposal }>(await call('POST',
      `/v1/sources/conversions/${conversion}/proposals/native-work`, { profile: 'open-library-native-work-proposal-v1' }), 201);
    return result.proposal;
  };
  const adoptWork = async (proposal: NativeWorkSourceProposal) => (await json<{ adoption: NativeWorkSourceAdoption }>(await call('POST',
    `/v1/sources/proposals/${shortId(proposal.proposal)}/adoption/native-work`, {
      profile: 'source-native-work-adoption-v1', confirmedTitle: proposal.candidateTitle,
      actingSubject: actor, titleLanguage: 'en' }), 201)).adoption;
  const input = (proposal: NativeWorkSourceProposal, work: NativeWorkSourceAdoption,
    sourceOrdinal: number, key = '/authors/OL1A'): AdoptSourceAuthorCreditInput & { profile: string } => ({
    profile: 'source-author-credit-adoption-v1', proposal: proposal.proposal, conversion: proposal.conversion,
    expectedHead: work.workRevision, actingSubject: actor, sourceOrdinal, nativeOrdinal: sourceOrdinal,
    occurrence: sourceChildOccurrence(proposal.observation, 'authors', sourceOrdinal),
    confirmedSourceKey: key, confirmedRoleKey: '/type/author_role',
    baseSupport: null, correspondence: null, confirmedUse: 'factual-reference-only' });
  return { account, pool, accessPool, env, access, intake, conversions, graph, proposals, credits, principalId, actor,
    call, json, grant, propose, adoptWork, input, nativeFuseki, creditCommands,
    failCertificate: () => { loseCertificate = true; }, loseGraph: () => { loseGraphResponse = true; },
    mutateCredit: (fn: (envelope: CommandEnvelope) => CommandEnvelope) => { mutate = fn; },
    close: async () => { await account.close(); await Promise.all([pool.end(), accessPool.end()]); } };
}
