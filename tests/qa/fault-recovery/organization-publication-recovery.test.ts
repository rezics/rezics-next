import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { AccessOrgRealmParticipation } from '../../../services/main/src/modules/access/org-realm-participation.ts';
import { AccessOrganizationModeration } from '../../../services/main/src/modules/access/organization-moderation.ts';
import { ORGANIZATION_MODERATION_PROFILE } from '../../../services/main/src/modules/access/organization-publication.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { initializeFreshGraph, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { accessStateCoverage } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { reconcileRetainedWorkCreate, reconcileRetainedContributionDraftCreate,
  reconcileRetainedContributionPublication, reconcileRetainedMainSelection,
  reconcileRetainedRealmSpaceCreate, reconcileRetainedRealmSelection, reconcileRetainedRealmRejection }
  from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { readExactContributionDraft } from '../../../services/main/src/modules/contribution/history.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { organizationPublicationFixture } from '../support/organization-publication.ts';

const root = resolve(import.meta.dir, '../../..');
function stack(action: 'stack:up' | 'stack:reset', runId: string) {
  const result = spawnSync('corepack', ['yarn', action, '--profile', 'qa', '--run-id', runId],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) throw new Error(`${action}: ${(result.stderr || result.stdout).slice(-1500)}`);
}
async function migrate(pool: Pool, owner: 'access' | 'relay') {
  const directory = join(root, 'services/main/migrations', owner);
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
    await pool.query(readFileSync(join(directory, file), 'utf8'));
  }
}

test('IAM23/OPS03: isolated Access cuts and graph replay preserve one exact local organization rejection', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA fault/recovery tier');
  const prefix = randomUUID().slice(0, 10);
  const liveId = `org-moderation-${prefix}-l`, restoreId = `org-moderation-${prefix}-r`;
  const directory = join(root, '.temp', `org-moderation-restore-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const started: string[] = [];
  let pool: Pool | undefined, relay: Pool | undefined, before: Pool | undefined, after: Pool | undefined;
  try {
    for (const id of [liveId, restoreId]) { started.push(id); stack('stack:up', id); }
    const liveDirectory = stackDirectory(root, { profile: 'qa', runId: liveId });
    const apps = readEnv(join(liveDirectory, 'apps.env'));
    const compose = readEnv(join(liveDirectory, 'compose.env'));
    const restoredApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoreId }), 'apps.env'));
    pool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    relay = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    await migrate(pool, 'access'); await migrate(relay, 'relay');
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    const restoredFuseki = new FusekiClient(restoredApps.FUSEKI_URL!, restoredApps.FUSEKI_MAINTENANCE_TOKEN!, restoredApps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    const env: WorkActivationEnvironment = { fuseki, lineage, objectDirectory: join(directory, 'objects') };
    await initializeFreshGraph(fuseki, lineage);
    const consumer = `org-moderation:${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, lineage.dataEpoch);
    // Authentication is isolated here; the paired integration case exercises real OAuth.
    const issuer = 'https://account.organization-recovery.test';
    const account = { verify: async (request: Request) => ({ issuer,
      subject: request.headers.get('authorization') === 'Bearer manager' ? 'manager' : 'organization' }) };
    const main = (fault = false) => {
      const access = new AccessAdmissionRegistry(pool!);
      return createMainApp(fuseki, { environment: env, account,
        access: fault ? new Proxy(access, { get: (owner, key) => key === 'recordGraphOutcome'
          ? async () => { throw new Error('Access connection lost after graph commit'); }
          : typeof Reflect.get(owner, key) === 'function' ? Reflect.get(owner, key).bind(owner) : Reflect.get(owner, key) }) : access,
        orgRealmParticipation: new AccessOrgRealmParticipation(pool!),
        organizationModeration: new AccessOrganizationModeration(pool!) });
    };
    const post = (path: string, token: string, body: object, key = randomUUID(), fault = false) =>
      main(fault).handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body) }));
    const s = await organizationPublicationFixture(pool, env, account,
      { issuer, realmAccount: 'manager', orgAccount: 'organization', realmToken: 'manager', orgToken: 'organization' }, post);
    const cloneAccess = async (name: string) => {
      await pool!.end();
      const admin = new Client({ connectionString:
        `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
      await admin.connect();
      try { await admin.query(`CREATE DATABASE ${name} WITH TEMPLATE access OWNER access`); }
      finally { await admin.end(); }
      pool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
      const url = new URL(apps.ACCESS_DATABASE_URL!); url.pathname = `/${name}`;
      return new Pool({ connectionString: url.toString() });
    };
    before = await cloneAccess('moderation_before');
    const key = randomUUID(), body = { profile: ORGANIZATION_MODERATION_PROFILE, ...s.target };
    const pending = await post('/v1/organization-publication-rejections', 'manager', body, key, true);
    expect(pending.status, await pending.clone().text()).toBe(202);
    const unsealed = (await pool!.query(`SELECT state FROM access.admission
      WHERE action = 'publication.reject.organization' AND idempotency_key = $1`, [key])).rows[0];
    expect(unsealed.state).toBe('claimed');
    const retry = await post('/v1/organization-publication-rejections', 'manager', body, key);
    expect(retry.status, await retry.clone().text()).toBe(200);
    const accepted = await retry.json() as { rejection: string; authorityProofDigest: string; sourcePosition: { sequence: string } };
    expect(accepted.sourcePosition.sequence).toBe('9');
    for (let n = 1; n <= 9; n++) expect((await relayMainOutboxOnce(fuseki, relay, consumer))?.sequence).toBe(String(n));
    const coverage = await relayCoverage(relay, consumer);
    await engageAccessRecoveryFence(pool!);
    after = await cloneAccess('moderation_after');
    expect(await accessStateCoverage(after)).toEqual(await accessStateCoverage(pool!));
    expect(await accessStateCoverage(before)).not.toEqual(await accessStateCoverage(after));
    await engageAccessRecoveryFence(before);
    const stored = (await after.query(`SELECT target, authority_proof, proof_digest
      FROM access.organization_publication_moderation`)).rows;
    expect(stored).toHaveLength(1); expect(stored[0].target).toEqual(s.target);
    expect(stored[0].proof_digest).toBe(accepted.authorityProofDigest);
    await expect(after.query('DELETE FROM access.organization_publication_moderation')).rejects.toThrow();
    await initializeFreshGraph(restoredFuseki, lineage);
    const next = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(restoredFuseki, { prior: { ...lineage, sequence: '0' }, next });
    const restored: WorkActivationEnvironment = { ...env, fuseki: restoredFuseki, lineage: next };
    await reconcileRetainedWorkCreate(restored, after, relay, coverage, '1');
    await reconcileRetainedContributionDraftCreate(restored, after, relay, coverage, '2');
    await reconcileRetainedContributionPublication(restored, after, relay, coverage, '3');
    await reconcileRetainedMainSelection(restored, after, relay, coverage, '4');
    await reconcileRetainedRealmSpaceCreate(restored, after, relay, coverage, '5');
    await reconcileRetainedRealmSelection(restored, after, relay, coverage, '6');
    await reconcileRetainedRealmSpaceCreate(restored, after, relay, coverage, '7');
    await reconcileRetainedRealmSelection(restored, after, relay, coverage, '8');
    // A graph receipt/relay record does not fill a lost Access decision tail.
    await expect(reconcileRetainedRealmRejection(restored, before, relay, coverage, '9')).rejects.toThrow();
    const retained = (await relay.query<{ event_id: string; envelope: unknown }>(
      'SELECT event_id, envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = 9', [lineage.dataEpoch])).rows[0]!;
    await relay.query(`UPDATE relay.delivered_event SET envelope = jsonb_set(envelope,
      '{data,receipt,requestDigest}', to_jsonb($1::text)) WHERE event_id = $2`, ['a'.repeat(64), retained.event_id]);
    await expect(reconcileRetainedRealmRejection(restored, after, relay, coverage, '9')).rejects.toThrow();
    await relay.query('UPDATE relay.delivered_event SET envelope = $1 WHERE event_id = $2', [retained.envelope, retained.event_id]);
    expect((await reconcileRetainedRealmRejection(restored, after, relay, coverage, '9')).rejection).toBe(accepted.rejection);
    expect((await reconcileRetainedRealmRejection(restored, after, relay, coverage, '9')).replayed).toBe(true);
    // Native selection and Lucene effects are checked while the held graph is still private to recovery.
    const state = await restoredFuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:current> {
        <${s.local.selection.slot}> rv:selectionHead <${accepted.rejection}> .
        <${s.other.selection.slot}> rv:selectionHead <${s.other.selection.selection}> .
        <${s.work.work}> rv:head <${s.work.workRevision}> .
        <${s.draft.contribution}> rv:author <${s.f.org}> . }
      GRAPH <${PUBLIC_SEARCH_GRAPH}> {
        <${s.other.selection.matchUnit}> a rv:MatchUnit . <${s.main.matchUnit}> a rv:MatchUnit . }
      FILTER NOT EXISTS { GRAPH <${PUBLIC_SEARCH_GRAPH}> { <${s.local.selection.matchUnit}> ?p ?o } }
    }`);
    expect(state.boolean).toBe(true);
    const text = await restoredFuseki.query(`PREFIX text: <http://jena.apache.org/text#> PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?unit WHERE { GRAPH <${PUBLIC_SEARCH_GRAPH}> {
        (?unit ?score) text:query (rv:searchBody ${JSON.stringify(s.body)} 10) } }`);
    const units = new Set(text.results?.bindings?.map(row => row.unit?.value));
    expect(units.has(s.local.selection.matchUnit)).toBe(false);
    expect(units.has(s.other.selection.matchUnit)).toBe(true); expect(units.has(s.main.matchUnit)).toBe(true);
    expect((await readExactContributionDraft(restored, s.target.contribution, s.target.selectedDraft,
      async () => true)).body).toBe(s.body);
  } finally {
    await Promise.all([pool?.end(), relay?.end(), before?.end(), after?.end()]);
    for (const id of started.reverse()) stack('stack:reset', id);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
