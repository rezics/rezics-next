import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { readManifest } from '../../../scripts/fixture/build.ts';
import {
  fixtureCorpus,
  PROFILES,
  workAt,
  workToken,
  publicUnitAt,
  type FixtureProfile,
} from '../../../scripts/fixture/corpus.ts';
import {
  compatibleFixture,
  type FixtureRestoreEvidence,
} from '../../../scripts/fixture/restore.ts';
import { checkSamples, workEnvironment } from '../../../scripts/fixture/smoke.ts';
import { fixtureProject } from '../../../scripts/fixture/stack.ts';
import {
  assertPinnedState,
  docker,
  inspectFusekiState,
  repositoryPins,
  type StatePins,
} from '../../../scripts/operations/search-state.ts';
import {
  qaStartupTestTimeout,
  runQaAdmissionChildAsync,
} from '../../../scripts/qa/stack-startup.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { readExactModelGeneration } from '../../../services/main/src/modules/semantic/model-custody.ts';
import { journalErasure, sha256 } from '../../../services/main/src/modules/erasure/journal.ts';
import { GRAPHS } from '../../../services/main/src/modules/work/activate.ts';
import { MODEL_COMPONENT } from '../../../services/main/src/modules/semantic/schema.ts';
import {
  fusekiSecrets,
  pinnedImage,
  qaStack,
  requireFaultTier,
  root,
  rootCommand,
  standaloneFuseki,
} from './search-ops-support.ts';

const RV = 'https://rezics.com/vocab/';
const PUBLIC = 'urn:rezics:search:public';
const PRIVATE = 'urn:rezics:search:private';
const CANDIDATE_BASE = '/fuseki/databases/campaign-candidate';
const CANDIDATE = `${CANDIDATE_BASE}/databases/rezics`;
const MEASURE = '/fuseki/databases/campaign-measure';
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const literal = (value: string) => JSON.stringify(value);

// The fixture owns no corpus builder: routine work restores retained whole-volume
// copies and adds only <=64 exact graph footprints, as in erasure-graph-purge.
// Medium managers prepare both sources with task fixture:restore before the
// 360-second fault-file timer, then supply ERASURE_CAMPAIGN_SOURCES=a,b.
test(
  'OPS10: retained populated fixture qualifies one physical erasure campaign and recovery',
  async () => {
    const { runId, artifacts } = requireFaultTier();
    const requested = process.env.ERASURE_CAMPAIGN_PROFILE ?? 'small';
    if (requested !== 'small' && requested !== 'medium')
      throw new Error('Campaign profile must be small or medium');
    const profile: FixtureProfile = requested;
    const nonce = randomUUID().replaceAll('-', '').slice(0, 10);
    const evidenceDirectory = join(
      root,
      '.temp',
      'erasure-campaign-qualification',
      `${runId}-${nonce}`,
    );
    mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    const evidence: Record<string, unknown> = {
      profile,
      startedAt: new Date().toISOString(),
      preparationCeilingMs: 600_000,
      faultFileActiveBudgetMs: 360_000,
      measurement: '250ms sampled allocated/apparent bytes; observed peak is a lower bound',
      destructionScope:
        'only the explicitly retired graph/Lucene fileset; retained fixture, owner objects, backups and media are not destroyed',
      phases: {},
      copies: [],
    };
    const phases = evidence.phases as Record<string, number>;
    const persist = () => {
      writeFileSync(
        join(evidenceDirectory, 'qualification.json'),
        JSON.stringify(evidence, null, 2),
        { mode: 0o600 },
      );
      writeFileSync(
        join(artifacts, 'erasure-campaign-qualification.json'),
        JSON.stringify(evidence, null, 2),
        { mode: 0o600 },
      );
    };
    const phase = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await work();
      } finally {
        phases[name] = Math.round(performance.now() - started);
        persist();
      }
    };
    const preparationStarted = performance.now();
    const harnessStart = Number(process.env.REZICS_QA_PREPARATION_STARTED_AT ?? Date.now());
    if (!Number.isFinite(harnessStart) || harnessStart > Date.now())
      throw new Error('Invalid QA preparation start');
    const harnessSetupMs = Date.now() - harnessStart;
    const supplied = process.env.ERASURE_CAMPAIGN_SOURCES?.split(',');
    if (
      supplied &&
      (supplied.length !== 2 ||
        new Set(supplied).size !== 2 ||
        supplied.some((id) => !/^fixture-[a-z0-9-]{1,27}$/.test(id)))
    )
      throw new Error('Supply two distinct successful fixture:restore source IDs');
    const ids = supplied ?? [`fixture-erasure-${nonce}-a`, `fixture-erasure-${nonce}-b`];
    const stacks = ids.map(qaStack);
    const pools: Pool[] = [];
    const candidateNames: string[] = [];
    const sourceOwners: { access: Pool; content: Pool }[] = [];
    const custodyProofs: string[] = [];
    let candidate: Awaited<ReturnType<typeof standaloneFuseki>> | undefined;
    let fixture: string | undefined;
    try {
      // This checks the exact repository image before fixture selection; no alias,
      // image substitution, fresh corpus build or compatibility bypass is permitted.
      evidence.release = repositoryPins(root, stacks[0]!.dockerEnv, stacks[0]!.stateVolume);
      const retained = process.env.ERASURE_CAMPAIGN_FIXTURE ?? compatibleFixture(profile)?.id;
      const manifest = retained ? readManifest(retained) : undefined;
      if (
        !manifest ||
        manifest.profile !== profile ||
        manifest.entities.works !== PROFILES[profile].works
      )
        throw new Error(
          `No compatible retained ${profile} ${PROFILES[profile].works}-Work backup; owner must resolve fixture compatibility before qualification`,
        );
      fixture = manifest.id;
      evidence.fixture = {
        manifest,
        manifestSha256: digest(JSON.stringify(manifest)),
        backupMounts: 'existing fixture:restore mounts all backup volumes read-only',
      };
      const restores: FixtureRestoreEvidence[] = [];
      let externalPreparationMs = 0;
      for (const [index, stack] of stacks.entries()) {
        if (!supplied) {
          await phase(`restore-${index}`, async () => {
            const result = await runQaAdmissionChildAsync(
              root,
              'task',
              ['fixture:restore', '--', '--fixture', manifest.id, '--run-id', ids[index]!],
              Math.max(1, 600_000 - (performance.now() - preparationStarted)),
            );
            writeFileSync(join(evidenceDirectory, `restore-command-${index}.log`), result.output, {
              mode: 0o600,
            });
            if (!result.ok)
              throw new Error(`fixture:restore failed; inspect restore-command-${index}.log`);
          });
        }
        const restore = JSON.parse(
          readFileSync(
            join(root, '.artifacts', 'fixture-restore', ids[index]!, 'run.json'),
            'utf8',
          ),
        ) as FixtureRestoreEvidence;
        if (
          restore.failure ||
          !restore.completedAt ||
          restore.target !== ids[index] ||
          restore.fixture !== manifest.id ||
          restore.profile !== profile ||
          restore.works !== PROFILES[profile].works ||
          !restore.compatibility?.compatible
        )
          throw new Error('Source lacks successful exact matching fixture:restore evidence');
        const wallMs = Date.parse(restore.completedAt) - Date.parse(restore.startedAt);
        if (!Number.isFinite(wallMs) || wallMs < 0 || (restore.elapsedMs ?? Infinity) > 600_000)
          throw new Error('Invalid restore preparation timing');
        restores.push(restore);
        writeFileSync(
          join(evidenceDirectory, `restore-${index}.json`),
          JSON.stringify(restore, null, 2),
        );
        const pins = await inspectFusekiState(stack.runner, stack.dockerEnv, stack.fuseki);
        assertPinnedState(
          pins,
          repositoryPins(root, stack.dockerEnv, stack.stateVolume, [
            `${fixtureProject(manifest.id)}_fuseki_data`,
            stacks[1 - index]!.stateVolume,
          ]),
        );
        (evidence.copies as unknown[]).push({
          id: ids[index],
          stateVolume: stack.stateVolume,
          pins,
        });
        const count = await stack.fuseki.query(
          `SELECT (COUNT(?work) AS ?n) WHERE { GRAPH <${GRAPHS.current}> { ?work a <https://schema.org/CreativeWork> } }`,
        );
        expect(Number(count.results?.bindings[0]?.n?.value)).toBe(PROFILES[profile].works);
        const owners = {
          access: new Pool({ connectionString: stack.apps.ACCESS_DATABASE_URL, max: 1 }),
          content: new Pool({ connectionString: stack.apps.CONTENT_DATABASE_URL, max: 1 }),
        };
        pools.push(owners.access, owners.content);
        sourceOwners.push(owners);
        await checkSamples(stack.apps, manifest, owners);
        stack.runner.stop();
      }
      evidence.restores = restores;
      if (supplied)
        externalPreparationMs =
          Math.max(...restores.map((restore) => Date.parse(restore.completedAt!))) -
          Math.min(...restores.map((restore) => Date.parse(restore.startedAt)));
      const corpus = fixtureCorpus(profile, manifest.seed);
      const targets = Array.from({ length: profile === 'medium' ? 64 : 4 }, (_, i) =>
        workAt(corpus, i + 1),
      );
      const unrelated = `urn:rezics:content:revision:${randomUUID()}`;
      const keptPublic = `urn:rezics:content:match-unit:${randomUUID()}`;
      const keptPrivate = `urn:rezics:content:private-unit:${randomUUID()}`;
      const forbiddenPublic = `erasurecampaignforbidden${nonce}`;
      const forbiddenPrivate = `erasurecampaignprivate${nonce}`;
      const retainedPhrase = `erasurecampaignretained${nonce}`;
      const unitIds = targets.flatMap((_, i) => [
        `urn:rezics:campaign:public-unit:${nonce}:${i}`,
        `urn:rezics:campaign:private-unit:${nonce}:${i}`,
      ]);
      const campaignFiles: string[] = [];
      for (const [index, stack] of stacks.entries()) {
        const relay = new Pool({ connectionString: stack.apps.ACCOUNT_RELAY_DATABASE_URL, max: 1 });
        pools.push(relay);
        const pairs: { iri: string; epoch: string }[] = [];
        for (let offset = 0; offset < targets.length; offset += Math.ceil(targets.length / 2)) {
          const group = targets.slice(offset, offset + Math.ceil(targets.length / 2));
          const journal = await journalErasure(relay, {
            operationId: `campaign-${nonce}-${index}-${offset}`,
            requestDigest: sha256(JSON.stringify(group.map((item) => item.contentRevision))),
            kind: 'revision',
            principalId: randomUUID(),
            admissionId: randomUUID(),
            authorityEpoch: '0',
            targets: group.map((item) => ({ kind: 'content_revision', ref: item.contentRevision })),
          });
          pairs.push(
            ...group.map((item) => ({
              iri: `urn:rezics:content:revision:${item.contentRevision}`,
              epoch: journal.erasureEpoch,
            })),
          );
        }
        const rows = pairs.map((pair) => `${pair.iri}\t${pair.epoch}\n`).join('');
        const campaignFile = join(evidenceDirectory, `campaign-${index}.tsv`);
        campaignFiles.push(campaignFile);
        writeFileSync(campaignFile, rows, { mode: 0o400 });
        const nq: string[] = [];
        const quad = (s: string, p: string, o: string, graph: string) =>
          nq.push(`<${s}> <${p}> ${o} <${graph}> .`);
        const type = (s: string, name: string, graph: string) =>
          quad(s, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `<${RV}${name}>`, graph);
        for (const [i, pair] of pairs.entries()) {
          type(pair.iri, 'ErasedRevision', GRAPHS.revisions);
          quad(
            pair.iri,
            `${RV}erasureEpoch`,
            `"${pair.epoch}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
            GRAPHS.revisions,
          );
          for (const [privateUnit, graph, body] of [
            [false, PUBLIC, forbiddenPublic],
            [true, PRIVATE, forbiddenPrivate],
          ] as const) {
            const projection = `urn:rezics:campaign:${privateUnit ? 'private-' : ''}projection:${nonce}:${i}`;
            const unit = unitIds[2 * i + Number(privateUnit)]!;
            type(
              projection,
              privateUnit ? 'ContentPrivateProjection' : 'ContentProjection',
              GRAPHS.revisions,
            );
            quad(projection, `${RV}contentRevision`, `<${pair.iri}>`, GRAPHS.revisions);
            quad(projection, `${RV}matchUnit`, `<${unit}>`, GRAPHS.revisions);
            type(unit, 'MatchUnit', graph);
            quad(unit, `${RV}revision`, `<${pair.iri}>`, graph);
            quad(unit, `${RV}projection`, `<${projection}>`, graph);
            quad(
              unit,
              `${RV}${privateUnit ? 'privateSearchBody' : 'searchBody'}`,
              `${literal(body)}@en`,
              graph,
            );
          }
        }
        type(unrelated, 'ErasedRevision', GRAPHS.revisions);
        quad(
          unrelated,
          `${RV}erasureEpoch`,
          '"987654321"^^<http://www.w3.org/2001/XMLSchema#integer>',
          GRAPHS.revisions,
        );
        for (const [unit, graph, field] of [
          [keptPublic, PUBLIC, 'searchBody'],
          [keptPrivate, PRIVATE, 'privateSearchBody'],
        ] as const) {
          type(unit, 'MatchUnit', graph);
          quad(unit, `${RV}${field}`, `${literal(retainedPhrase)}@en`, graph);
        }
        // Only bounded target/counterexample quads are loaded; existing corpus,
        // model generations, command payloads and immutable objects are never replayed.
        stack.runner.offline(`test -f /fuseki/databases/rezics/clean-stop
exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /fuseki/databases/campaign-seed.nq <<'NQ'
${nq.join('\n')}
NQ
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbloader --loader=phased --loc=/fuseki/databases/rezics/tdb2 /fuseki/databases/campaign-seed.nq`);
        await stack.runner.start();
        const bodies = await stack.fuseki
          .query(`PREFIX rv: <${RV}> SELECT (COUNT(?body) AS ?n) WHERE {
          VALUES ?unit { ${unitIds.map((unit) => `<${unit}>`).join(' ')} }
          GRAPH ?g { ?unit ?p ?body } VALUES ?p { rv:searchBody rv:privateSearchBody } }`);
        expect(Number(bodies.results?.bindings[0]?.n?.value)).toBe(2 * pairs.length);
        const proof = await retainedCustody(
          stack.fuseki,
          stack.apps,
          manifest,
          sourceOwners[index]!.access,
        );
        custodyProofs.push(JSON.stringify(proof));
        (evidence.copies as Record<string, unknown>[])[index]!.sourceCustody = proof;
        stack.runner.stop();
      }
      const preparationMs = Math.round(
        performance.now() - preparationStarted + externalPreparationMs + harnessSetupMs,
      );
      evidence.preparation = {
        elapsedMs: preparationMs,
        externalRestoreSpanMs: externalPreparationMs,
        harnessSetupMs,
        ceilingMs: 600_000,
      };
      if (preparationMs > 600_000)
        throw new Error(`Actual preparation ${preparationMs}ms exceeded 600000ms`);
      persist();

      for (const [index, stack] of stacks.entries()) {
        const name = `rezics-campaign-${nonce}-${index}`;
        candidateNames.push(name);
        const campaignFile = campaignFiles[index]!;
        const pairs = readFileSync(campaignFile, 'utf8')
          .trimEnd()
          .split('\n')
          .map((row) => row.split('\t') as [string, string]);
        const run = (script: string, timeout = 600_000) => {
          const result = stack.compose(
            [
              'run',
              '--rm',
              '--no-deps',
              '-T',
              '--volume',
              `${campaignFile}:/campaign.tsv:ro`,
              '--volume',
              `${join(root, 'infra/jena/purge-tdb2.sh')}:/qualification/purge-tdb2.sh:ro`,
              '--volume',
              `${join(root, 'infra/jena/purge-activate.sh')}:/qualification/purge-activate.sh:ro`,
              '--entrypoint',
              'sh',
              'fuseki',
              '-ec',
              script,
            ],
            timeout,
          );
          if (result.status !== 0)
            throw new Error(
              `Campaign native command failed (${result.status}): ${result.output.slice(-6000)}`,
            );
          return result.output;
        };
        const buildOutput = await phase(`copy-compact-index-${index}`, () => run(measuredBuild()));
        writeFileSync(join(evidenceDirectory, `native-${index}.log`), buildOutput);
        expect(buildOutput.match(/campaignTargets=/g)).toHaveLength(1);
        expect(buildOutput).toContain(`campaignTargets=${pairs.length}`);
        const measurements = run(`cat ${MEASURE}/sizes.tsv`);
        const nativePhases = run(`cat ${MEASURE}/phases.tsv`);
        const summary = summarizeMeasurements(measurements, nativePhases);
        writeFileSync(join(evidenceDirectory, `sizes-${index}.tsv`), measurements);
        writeFileSync(join(evidenceDirectory, `phases-${index}.tsv`), nativePhases);
        (evidence.copies as Record<string, unknown>[])[index]!.measurements = summary;
        const ready = run(`cat ${CANDIDATE}/erasure-purge.ready`);
        expect(ready).toContain(`campaign-sha256=${digest(readFileSync(campaignFile, 'utf8'))}\n`);
        (evidence.copies as Record<string, unknown>[])[index]!.ready = ready;
        // The copied candidate is served only in an isolated loopback container for
        // exact read probes, then cleanly stopped before its readiness is verified.
        candidate = await standaloneFuseki(stack.dockerEnv, {
          name,
          image: pinnedImage(),
          volume: stack.stateVolume,
          secrets: { ...fusekiSecrets(stack.composeEnv), FUSEKI_BASE: CANDIDATE_BASE },
          command: [
            'sh',
            '-ec',
            `cd ${CANDIDATE_BASE} && exec /opt/apache-jena-fuseki-6.2.0/fuseki-server --port=3030 --no-cors --timeout=10000 --config=/fuseki/fuseki-text.ttl`,
          ],
        });
        const client = new FusekiClient(
          candidate.url,
          stack.apps.FUSEKI_MAINTENANCE_TOKEN,
          stack.apps.FUSEKI_COMMAND_TOKEN,
        );
        const sourcePins = (evidence.copies as { pins: StatePins }[])[index]!.pins;
        expect(docker(['inspect', name, '--format', '{{.Image}}'], stack.dockerEnv).trim()).toBe(
          sourcePins.imageId,
        );
        const candidatePins = candidate.runner
          .exec(
            `sha256sum ${CANDIDATE_BASE}/extra/fuseki-command.jar ${CANDIDATE_BASE}/fuseki-text.ttl`,
          )
          .trim()
          .split('\n')
          .map((row) => row.split(/\s+/)[0]);
        expect(candidatePins).toEqual([
          sourcePins.commandJarSha256,
          sourcePins.indexerAssemblerSha256,
        ]);
        expect((await client.commandHealth()).moduleVersion).toBe(sourcePins.moduleVersion);
        await phase(`verify-${index}`, async () => {
          for (const [iri, epoch] of pairs) {
            expect(
              (
                await client.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.revisions}> {
            <${iri}> a rv:ErasedRevision ; rv:erasureEpoch ${epoch} . }
            FILTER NOT EXISTS { GRAPH <${GRAPHS.revisions}> { <${iri}> rv:erasureEpoch ?other FILTER(?other != ${epoch}) } }
            FILTER NOT EXISTS { GRAPH ?g { ?unit ?p <${iri}> } }
            FILTER NOT EXISTS { GRAPH ?g { <${iri}> ?p ?o . FILTER(?g != <${GRAPHS.revisions}> || ?p NOT IN (rv:erasureEpoch, <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)) } } }`)
              ).boolean,
            ).toBe(true);
          }
          expect(
            (
              await client.query(
                `PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.revisions}> { <${unrelated}> a rv:ErasedRevision ; rv:erasureEpoch 987654321 } }`,
              )
            ).boolean,
          ).toBe(true);
          for (const [graph, field, forbidden, kept] of [
            [PUBLIC, 'searchBody', forbiddenPublic, keptPublic],
            [PRIVATE, 'privateSearchBody', forbiddenPrivate, keptPrivate],
          ] as const) {
            const text = (phrase: string) =>
              client.query(`PREFIX text: <http://jena.apache.org/text#> SELECT ?unit ?literal WHERE {
            GRAPH <${graph}> { (?unit ?score ?literal) text:query (<${RV}${field}> ${literal(phrase)} 128) } }`);
            expect((await text(forbidden)).results?.bindings ?? []).toEqual([]);
            expect(
              (await text(retainedPhrase)).results?.bindings.map((row) => row.unit?.value),
            ).toEqual([kept]);
          }
          const owners = sourceOwners[index]!;
          // Use the source owner credentials and immutable bucket with only Fuseki
          // redirected to the candidate. The retained exact samples remain unchanged.
          const candidateApps = { ...stack.apps, FUSEKI_URL: candidate!.url };
          await checkSamples(candidateApps, manifest, owners);
          for (const sample of manifest.samples) {
            const hit =
              await client.query(`PREFIX text: <http://jena.apache.org/text#> SELECT ?work WHERE {
              GRAPH <${GRAPHS.current}> { (?work ?score ?literal) text:query
              (<http://www.w3.org/2000/01/rdf-schema#label> ${literal(workToken(sample.index))} 10) } }`);
            expect(hit.results?.bindings.map((row) => row.work?.value)).toEqual([sample.work]);
          }
          for (const ordinal of [0, Math.floor(corpus.publicUnits / 2), corpus.publicUnits - 1]) {
            const sample = publicUnitAt(corpus, ordinal);
            const hit =
              await client.query(`PREFIX text: <http://jena.apache.org/text#> SELECT ?unit WHERE {
              GRAPH <${PUBLIC}> { (?unit ?score ?literal) text:query (<${RV}searchBody> ${literal(sample.work.token)} 10) } }`);
            expect(hit.results?.bindings.map((row) => row.unit?.value)).toEqual([sample.unit]);
          }
          const proof = await retainedCustody(client, candidateApps, manifest, owners.access);
          expect(JSON.stringify(proof)).toBe(custodyProofs[index]!);
          (evidence.copies as Record<string, unknown>[])[index]!.candidateCustody = proof;
        });
        await candidate.runner.stop();
        candidate.remove();
        candidate = undefined;
        run(`cp ${CANDIDATE}/erasure-purge.ready ${CANDIDATE}/erasure-purge.verified`);
        const activation = (mode: string, retirement: string) =>
          run(
            `sh /qualification/purge-activate.sh ${mode} ${mode === 'activate' ? CANDIDATE_BASE : retirement} --campaign /campaign.tsv ${retirement}`,
            600_000,
          );
        if (index === 0) {
          await phase('activation-before-rollback', () =>
            activation('activate', 'qualification-rollback'),
          );
          await phase('rollback', () => activation('rollback', 'qualification-rollback'));
          // Source fingerprint checks in the real rollback prove byte-identical
          // restoration. The other isolated copy exercises irreversible unlink.
          expect(
            run(`cat /fuseki/databases/erasure-retirement-qualification-rollback/phase`),
          ).toContain('rolled-back');
        } else {
          await phase('activation', () => activation('activate', 'qualification-retire'));
          await phase('active-restart', async () => {
            await stack.runner.start();
          });
          expect(
            (
              await stack.fuseki
                .query(`PREFIX text: <http://jena.apache.org/text#> SELECT ?unit WHERE { GRAPH <${PUBLIC}> {
          (?unit ?score) text:query (<${RV}searchBody> ${literal(forbiddenPublic)} 128) } }`)
            ).results?.bindings ?? [],
          ).toEqual([]);
          stack.runner.stop();
          await phase('retirement', () => {
            const retired = activation('destroy', 'qualification-retire');
            const hash = /evidence-sha256=([0-9a-f]{64})/.exec(retired)?.[1];
            if (!hash) throw new Error('No exact retirement evidence');
            const receipt = run(
              'cat /fuseki/databases/rezics/erasure-purge.retired-qualification-retire',
            );
            expect(digest(receipt)).toBe(hash);
            expect(receipt).toContain('source-sha256=');
            (evidence.copies as Record<string, unknown>[])[index]!.retirement = {
              hash,
              receipt,
              campaign: readFileSync(campaignFile, 'utf8'),
            };
            run(
              'test ! -e /fuseki/databases/rezics-retired-qualification-retire && test ! -e /fuseki/databases/purge.incomplete',
            );
          });
        }
      }
      expect(digest(JSON.stringify(readManifest(manifest.id)))).toBe(
        digest(JSON.stringify(manifest)),
      );
      evidence.completedAt = new Date().toISOString();
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      candidate?.remove();
      // Existing standaloneFuseki starts the container before readiness; a
      // rejected readiness probe still needs cleanup by its already-known name.
      for (const name of candidateNames)
        spawnSync('docker', ['rm', '-f', name], {
          env: stacks[0]!.dockerEnv,
          encoding: 'utf8',
          timeout: 60_000,
        });
      await Promise.allSettled(pools.map((pool) => pool.end()));
      evidence.fixtureBackupRetained = fixture ?? null;
      persist();
      // Supplied manager copies remain stopped. Automatic routine copies belong
      // to this run's existing QA cleanup; the retained fixture is never reset.
      for (const stack of stacks) {
        if (!readFileExists(join(stack.directory, 'compose.env'))) continue;
        if (!supplied) await rootCommand(['stack:reset', ...stack.args], 300_000);
        else await rootCommand(['stack:down', ...stack.args], 120_000);
      }
    }
  },
  qaStartupTestTimeout(360_000),
);

function readFileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function measuredBuild(): string {
  return `mkdir -p ${MEASURE}/bin
real_java=$(command -v java)
export ERASURE_REAL_JAVA="$real_java"
cat > ${MEASURE}/bin/java <<'SH'
#!/bin/sh
case "$*" in
  *com.rezics.jena.ErasurePurge*) phase=copy ;;
  *tdbcompact*) phase=compact ;;
  *com.rezics.jena.ErasureTextIndexer*) phase=index ;;
  *) exit 64 ;;
esac
printf '%s start %s\\n' "$phase" "$(date +%s%3N)" >> ${MEASURE}/phases.tsv
"$ERASURE_REAL_JAVA" "$@"
result=$?
printf '%s end %s %s\\n' "$phase" "$(date +%s%3N)" "$result" >> ${MEASURE}/phases.tsv
exit "$result"
SH
chmod 700 ${MEASURE}/bin/java
export PATH=${MEASURE}/bin:$PATH
sample() {
  alloc() { if [ -d "$1" ]; then du -sk "$1" 2>/dev/null | cut -f1; else echo 0; fi; }
  apparent() { if [ -d "$1" ]; then du -sb "$1" 2>/dev/null | cut -f1; else echo 0; fi; }
  printf '%s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s\\n' \
    "$(date +%s%3N)" "$(alloc /fuseki/databases)" "$(apparent /fuseki/databases)" \
    "$(alloc /fuseki/databases/rezics)" "$(apparent /fuseki/databases/rezics)" \
    "$(alloc /fuseki/databases/rezics/tdb2)" "$(apparent /fuseki/databases/rezics/tdb2)" \
    "$(alloc /fuseki/databases/rezics/lucene)" "$(apparent /fuseki/databases/rezics/lucene)" \
    "$(alloc ${CANDIDATE_BASE})" "$(apparent ${CANDIDATE_BASE})" \
    "$(alloc ${CANDIDATE}/tdb2)" "$(apparent ${CANDIDATE}/tdb2)" \
    "$(alloc ${CANDIDATE}/lucene)" "$(apparent ${CANDIDATE}/lucene)" \
    "$(df -Pk /fuseki/databases | tail -n 1 | awk '{print $4}')" >> ${MEASURE}/sizes.tsv
}
sample
(while :; do sample; sleep 0.25; done) & monitor=$!
trap 'kill "$monitor" 2>/dev/null || true; wait "$monitor" 2>/dev/null || true' EXIT
sh /qualification/purge-tdb2.sh ${CANDIDATE_BASE} --campaign /campaign.tsv
kill "$monitor"; wait "$monitor" 2>/dev/null || true
trap - EXIT
sample`;
}

function summarizeMeasurements(sizes: string, phases: string) {
  const rows = sizes
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number));
  if (
    rows.length < 2 ||
    rows.some(
      (row) => row.length !== 16 || row.some((value) => !Number.isSafeInteger(value) || value < 0),
    )
  )
    throw new Error('Invalid sampled disk evidence');
  const durations: Record<string, number> = {};
  for (const name of ['copy', 'compact', 'index']) {
    const starts = phases
      .trim()
      .split('\n')
      .filter((row) => row.startsWith(`${name} start `));
    const ends = phases
      .trim()
      .split('\n')
      .filter((row) => row.startsWith(`${name} end `));
    if (starts.length !== 1 || ends.length !== 1 || !ends[0]!.endsWith(' 0'))
      throw new Error(`${name} must execute exactly once successfully`);
    durations[name] = Number(ends[0]!.split(' ')[2]) - Number(starts[0]!.split(' ')[2]);
    if (!Number.isSafeInteger(durations[name]) || durations[name]! < 0)
      throw new Error('Invalid native phase timing');
  }
  const first = rows[0]!,
    last = rows.at(-1)!;
  return {
    phasesMs: durations,
    sampleDelayMs: 250,
    samples: rows.length,
    maximumObservedSampleGapMs: Math.max(...rows.slice(1).map((row, i) => row[0]! - rows[i]![0]!)),
    sourceAllocatedBytes: first[3]! * 1024,
    sourceApparentBytes: first[4],
    sourceGraphAllocatedBytes: first[5]! * 1024,
    sourceGraphApparentBytes: first[6],
    sourceIndexAllocatedBytes: first[7]! * 1024,
    sourceIndexApparentBytes: first[8],
    candidateAllocatedBytes: last[9]! * 1024,
    candidateApparentBytes: last[10],
    candidateGraphAllocatedBytes: last[11]! * 1024,
    candidateGraphApparentBytes: last[12],
    candidateIndexAllocatedBytes: last[13]! * 1024,
    candidateIndexApparentBytes: last[14],
    finalVolumeApparentBytes: last[2],
    peakVolumeAllocatedBytes: Math.max(...rows.map((row) => row[1]! * 1024)),
    peakVolumeApparentBytes: Math.max(...rows.map((row) => row[2]!)),
    minimumFilesystemFreeBytes: Math.min(...rows.map((row) => row[15]! * 1024)),
  };
}

async function retainedCustody(
  client: FusekiClient,
  apps: Record<string, string>,
  manifest: NonNullable<ReturnType<typeof readManifest>>,
  access: Pool,
) {
  const revisions = manifest.samples.flatMap((sample) => [
    sample.workRevision,
    sample.mainRevision,
  ]);
  const facts = await client.query(
    `PREFIX rv: <${RV}> SELECT ?g ?s ?p ?o WHERE {
    { VALUES ?g { <${GRAPHS.receipts}> <${GRAPHS.outbox}> } GRAPH ?g { ?s ?p ?o } }
    UNION { BIND(<${GRAPHS.control}> AS ?g) VALUES ?p { rv:dataEpoch rv:routingEpoch rv:sequence rv:modelHead rv:shapeHead rv:modelGeneration rv:modelGenerationHead }
      GRAPH ?g { ?s ?p ?o } }
    UNION { BIND(<${GRAPHS.current}> AS ?g) VALUES ?s { <${MODEL_COMPONENT}> } GRAPH ?g { ?s ?p ?o } }
    UNION { BIND(<${GRAPHS.revisions}> AS ?g) VALUES ?s { ${revisions.map((revision) => `<${revision}>`).join(' ')} } GRAPH ?g { ?s ?p ?o } }
    UNION { BIND(<${GRAPHS.revisions}> AS ?g) GRAPH ?g { ?s a rv:ModelGeneration ; ?p ?o } }
  } ORDER BY ?g ?s ?p ?o`,
    16_777_216,
  );
  const generations = await client.query(`PREFIX rv: <${RV}> SELECT ?generation WHERE {
    GRAPH <${GRAPHS.revisions}> { ?generation a rv:ModelGeneration } } ORDER BY ?generation`);
  const originals = [];
  for (const row of generations.results?.bindings ?? []) {
    if (!row.generation) throw new Error('Missing exact model generation');
    const model = await readExactModelGeneration(
      workEnvironment(apps, manifest.lineage),
      row.generation.value,
    );
    originals.push({
      generation: model.generation,
      manifestSha256: model.manifestSha256,
      manifestBytes: model.manifest.length,
      commandModule: model.commandModule,
      shapes: model.shapes
        .map((shape) => ({
          profile: shape.profile,
          sha256: shape.sha256,
          bytes: shape.bytes.length,
        }))
        .sort((a, b) => a.profile.localeCompare(b.profile)),
    });
  }
  // Exact graph proof tuples are retained in full above; original command-object
  // reads sample at most 16 proofs, independently of population size.
  const proofs =
    await client.query(`PREFIX rv: <${RV}> SELECT ?receipt ?digest ?payload ?epoch ?sequence ?stream WHERE {
    GRAPH <${GRAPHS.receipts}> { ?receipt a rv:CommitProof ; rv:requestDigest ?digest ; rv:payloadDigest ?payload ;
      rv:dataEpoch ?epoch ; rv:sequence ?sequence ; rv:streamSequence ?stream } } ORDER BY ?receipt LIMIT 16`);
  const commandObjects = [];
  const store = workEnvironment(apps, manifest.lineage).workObjects;
  for (const proof of proofs.results?.bindings ?? []) {
    const row = (
      await access.query<{
        request_digest: string;
        payload_sha256: string;
        payload: Buffer;
        terminal: {
          receipt: string;
          dataEpoch: string;
          sequence: string;
          streamSequence: string;
        } | null;
      }>(
        'SELECT request_digest, payload_sha256, payload, terminal FROM access.command_custody WHERE receipt = $1',
        [proof.receipt!.value],
      )
    ).rows[0];
    if (
      !row ||
      row.request_digest !== proof.digest!.value ||
      row.payload_sha256 !== proof.payload!.value ||
      digest(row.payload) !== row.payload_sha256 ||
      !row.terminal ||
      row.terminal.receipt !== proof.receipt!.value ||
      row.terminal.dataEpoch !== proof.epoch!.value ||
      row.terminal.sequence !== proof.sequence!.value ||
      row.terminal.streamSequence !== proof.stream!.value
    )
      throw new Error('Exact command proof lacks matching original owner custody');
    const object = await store.get(row.payload_sha256);
    if (!Buffer.from(object).equals(row.payload))
      throw new Error('Original command payload object differs');
    const command = JSON.parse(Buffer.from(object).toString('utf8')) as {
      format?: string;
      manifest?: string;
    };
    const manifestSha256 = /^urn:rezics:sha256:([0-9a-f]{64})$/.exec(command.manifest ?? '')?.[1];
    if (command.format !== 'rezics-owner-command-v1' || !manifestSha256)
      throw new Error('Original command manifest binding is absent');
    const manifestObject = JSON.parse(
      Buffer.from(await store.get(manifestSha256)).toString('utf8'),
    ) as { format?: string; payload?: string };
    const payloadSha256 = /^sha256:([0-9a-f]{64})$/.exec(manifestObject.payload ?? '')?.[1];
    if (manifestObject.format !== 'rezics-manifest-v1' || !payloadSha256)
      throw new Error('Original component payload binding is absent');
    await store.get(payloadSha256);
    commandObjects.push({
      receipt: proof.receipt!.value,
      commandSha256: row.payload_sha256,
      manifestSha256,
      payloadSha256,
    });
  }
  return {
    factsSha256: digest(JSON.stringify(facts.results?.bindings ?? [])),
    factCount: facts.results?.bindings.length ?? 0,
    exactOriginalModelGenerations: originals,
    sampleObjectReads: manifest.samples.length,
    sampledCommandObjects: commandObjects,
    // An empty inventory makes no claim about the shared graph's backfill.
    modelCoverage: originals.length
      ? 'all source generations read from original custody'
      : 'no ModelGeneration present in this fixture source',
  };
}
