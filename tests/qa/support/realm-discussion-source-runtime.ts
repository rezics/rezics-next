import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, stable } from '../../../scripts/fixture/corpus.ts';
import { migrationInventory, type RetainedOwnerState } from '../../../scripts/fixture/manifest.ts';
import { dockerEnvironment, postgresImage, projectRunning, removeStoppedContainers, removeVolumes,
  root, run, stream, VOLUME_KINDS } from '../../../scripts/fixture/stack.ts';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import { recordRetainedPostgresCollations } from '../../../scripts/fixture/runtime-facts.ts';
import { retainStoppedOwnerBackup, restoreCatalogueBackup } from '../../../scripts/load/catalogue-backup.ts';
import { stopCorpusSourcePostgres } from '../../../scripts/load/corpus-backup-driver.ts';
import { RetainedSources, sourceFileDigests } from '../../../scripts/qa/retained-source.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { producerModules, retainedVolumeInventory } from '../fault-recovery/owner-restore-erasure-fixture.ts';
import { personaSessions, retainPersonaRealm, restorePersonaRealms } from './personas.ts';
import { realmDiscussionSourceAdapter, realmDiscussionSourceSpecification, realmSourceAuthorityLifetimeMs,
  realmSourceRankingAt, type RealmSourceRuntime, type RealmSourceSessions } from './realm-discussion-source.ts';

// Confirmations may read retained inputs from another checkout, but this
// producer's physical backup publication belongs to the running checkout.
export const realmSourceDirectory = () => join(root, '.temp', 'realm-discussion-sources');
const physicalNamespace = sha256(root);
// Separate local producer custody across worktrees without making a physical
// path an API corpus input. Cleanup can affect only this checkout's resources.
const backupIdentity = (key: string, namespace = physicalNamespace) => `realm-${sha256(stable([namespace, key])).slice(0, 54)}`;

export async function realmSourceInputs(sourceRoot = root) {
  const files = producerModules(sourceRoot, ['tests/qa/support/realm-discussion-source.ts',
    'tests/qa/support/realm-discussion-source-runtime.ts', 'tests/qa/support/personas.ts',
    'yarn.lock', 'package.json', 'services/main/package.json', 'services/content/package.json', 'services/account/package.json']);
  return realmDiscussionSourceSpecification({ ...sourceFileDigests(sourceRoot, files), ...migrationInventory(sourceRoot) },
    JSON.parse(stable({ storage: loadCompatibility(sourceRoot), postgres: postgresImage() })) as RetainedOwnerState);
}

/** Restore changes transport addresses; it preserves Account's logical issuer
 * and the copied OAuth clients. No owner principal/grant is rewritten. */
async function withEnvironment<T>(environment: Record<string, string>, work: () => Promise<T>) {
  const previous = new Map(Object.keys(environment).map(key => [key, Bun.env[key]]));
  Object.assign(Bun.env, environment);
  try { return await work(); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value; } }
}

export function realmSourceRuntime(sourceRunId = Bun.env.REZICS_QA_RUN_ID): RealmSourceRuntime {
  if (!sourceRunId) throw new Error('Realm source requires an admitted integration QA environment');
  const docker = dockerEnvironment();
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    qaIdentity: sourceRunId,
    async bootstrap(observe, phase) {
      const observer = (service: 'Main' | 'Account'): NonNullable<NonNullable<Parameters<typeof personaSessions>[1]>['observeMain']> => async event => {
        observe({ phase: phase(), service: service === 'Account' && event.request.path.startsWith('/api/v1/') ? 'Mailpit' : service,
          caller: { accountId: event.caller.accountId, actingSubject: event.caller.actingSubject },
          method: event.request.method, path: event.request.path, key: event.request.key,
          body: service === 'Main' ? event.request.body : null,
          startedAt: event.requestStartedAt, finishedAt: event.answeredAt, status: event.response.status,
          answer: service === 'Main' ? JSON.parse(event.response.body) : null });
      };
      const options = { observeMain: observer('Main'), observeAccount: observer('Account'),
        rankingAt: realmSourceRankingAt,
        moderatorLifetimeMs: realmSourceAuthorityLifetimeMs };
      const rankingPublic = await personaSessions('public', options);
      try {
        return { rankingPublic, rankingPrivate: await personaSessions('private', options),
          discussionPublic: await personaSessions('public', options), discussionPrivate: await personaSessions('private', options) };
      } catch (error) { await rankingPublic.close(); throw error; }
    },
    retain: retainPersonaRealm,
    async cut(context, metadata) {
      const pool = boundedPool({ connectionString: Bun.env.ACCESS_DATABASE_URL, connectionTimeoutMillis: 2_000 });
      try { await recordRetainedPostgresCollations(context.backup, sql => pool.query(sql)); }
      finally { await pool.end(); }
      const signal = AbortSignal.timeout(context.budget.remaining());
      const native = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN);
      const rdf = stable(await native.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o'));
      writeFileSync(join(context.backup, 'rdf-cut.json'), rdf + '\n', { mode: 0o600 });
      const path = await retainStoppedOwnerBackup(sourceRunId, backupIdentity(context.key), join(context.backup, 'owners'), Date.now(), {
        signal, resumeSource: false, purpose: 'corpus',
        stopSourcePostgres: () => stopCorpusSourcePostgres(sourceRunId, signal),
      });
      const backup = JSON.parse(readFileSync(path, 'utf8')) as { project: string };
      const volumes = Object.fromEntries(VOLUME_KINDS.map(kind => [kind,
        retainedVolumeInventory(`${backup.project}_${kind}`, docker)]));
      context.budget.remaining();
      return { rdfDigest: sha256(readFileSync(join(context.backup, 'rdf-cut.json'))),
        ownerState: JSON.parse(stable({ corpus: metadata, physicalNamespace, physicalProject: backup.project, volumes })) as RetainedOwnerState };
    },
    async verify(context, state, rdfDigest) {
      const backup = JSON.parse(readFileSync(join(context.backup, 'owners', 'backup.json'), 'utf8')) as { project: string };
      if (typeof state.physicalNamespace !== 'string' || !/^[a-f0-9]{64}$/.test(state.physicalNamespace))
        return ['Realm source physical custody namespace is missing'];
      const expected = new RegExp(`^rezics-catalogue-corpus-[a-z0-9][a-z0-9-]{0,30}-${backupIdentity(context.key, state.physicalNamespace)}-[a-f0-9]{16}$`);
      if (!expected.test(backup.project) || state.physicalProject !== backup.project)
        return ['Realm source physical project differs from producer key'];
      const evidence: string[] = [];
      if (projectRunning(backup.project, docker)) evidence.push('Realm retained source is running');
      const saved = state.volumes as RetainedOwnerState;
      for (const kind of VOLUME_KINDS) {
        if (stable(retainedVolumeInventory(`${backup.project}_${kind}`, docker)) !== stable(saved[kind]))
          evidence.push(`Realm retained ${kind} inventory differs`);
        context.budget.remaining();
      }
      if (sha256(readFileSync(join(context.backup, 'rdf-cut.json'))) !== rdfDigest) evidence.push('Realm RDF cut differs');
      return evidence;
    },
    async restore(context, metadata) {
      const started = Date.now(), runId = `realm-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      context.budget.remaining();
      const signal = new AbortController().signal;
      // Source verification owns admission accounting, separately from active restore work.
      const copy = await restoreCatalogueBackup(join(context.backup, 'owners', 'backup.json'), runId, { signal, resourceClass: 'ordinary' });
      context.budget.excludeAdmissionWait(copy.admissionWaitMs);
      let sessions: RealmSourceSessions | undefined;
      try {
        await stream('bun', ['scripts/load/work-profile-restore-migrations.ts',
          `.temp/stack/rezics-qa-${runId}/apps.env`], docker, undefined, context.budget.remaining(), signal);
        const realms = await withEnvironment({ ...copy.apps, REZICS_QA_RUN_ID: runId, REZICS_QA_STACK_TIER: 'integration' },
          () => restorePersonaRealms([metadata.realms.rankingPublic, metadata.realms.rankingPrivate,
            metadata.realms.discussionPublic, metadata.realms.discussionPrivate], { rankingAt: metadata.rankingAt }));
        sessions = { rankingPublic: realms[0]!, rankingPrivate: realms[1]!, discussionPublic: realms[2]!, discussionPrivate: realms[3]! };
        const totalMs = Date.now() - started;
        const live = sessions;
        return { sessions: live, metadata, runId,
          preparation: { ...copy.preparation, totalMs,
            readinessMs: totalMs - copy.preparation.restoreMs - copy.preparation.startupMs,
            admissionWaitMs: copy.admissionWaitMs },
          async close() { try { await live.rankingPublic.close(); } finally { await copy.stop(); } } };
      } catch (error) { try { await sessions?.rankingPublic.close(); } finally { await copy.stop(); } throw error; }
    },
    async remove(key) {
      if (!/^rs-realm-discussion-source-[a-f0-9]{64}$/.test(key)) throw new Error('Realm source removal belongs to another producer');
      const pattern = new RegExp(`^(rezics-catalogue-corpus-[a-z0-9][a-z0-9-]{0,30}-${backupIdentity(key)}-[a-f0-9]{16})_(?:postgres_data|fuseki_data|rustfs_data)$`);
      const projects = new Map<string, string[]>();
      for (const volume of run('docker', ['volume', 'ls', '-q'], docker).trim().split('\n')) {
        const match = pattern.exec(volume);
        if (match) projects.set(match[1]!, [...projects.get(match[1]!) ?? [], volume]);
      }
      for (const [project, volumes] of projects) {
        if (projectRunning(project, docker)) throw new Error('Refuse removal of a running retained Realm source');
        removeStoppedContainers(project, docker); removeVolumes(volumes, docker);
      }
    },
  };
}

if (import.meta.main) {
  if (process.argv[2] !== '--prepare' || process.argv.length !== 3)
    throw new Error('Realm source accepts only an explicit --prepare under admitted QA preparation');
  // The consumer factory dynamically imports this module. Awaiting it from
  // this module's own top-level entry waits forever for our evaluation to end.
  const adapter = realmDiscussionSourceAdapter(await realmSourceInputs(), realmSourceRuntime());
  const sources = new RetainedSources(realmSourceDirectory());
  const result = await sources.prepare(adapter);
  // A bounded summary names custody; it never prints private credential metadata.
  console.log(JSON.stringify({ key: result.manifest.key, digest: result.manifest.digest, built: result.built,
    producerBuild: result.manifest.provenance.producerBuild, preparationMs: result.elapsedMs,
    admissionWaitMs: result.admissionWaitMs, manifest: result.manifest.provenance.manifestPath }));
}
