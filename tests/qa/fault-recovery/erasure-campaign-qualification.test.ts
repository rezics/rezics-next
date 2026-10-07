import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  checkSamples,
  workEnvironment,
  type FixtureSampleCall,
} from '../../../scripts/fixture/smoke.ts';
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
const PREPARATION_ACTIVE_BUDGET_MS = 600_000;
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
      routinePreparationActiveCeilingMs: PREPARATION_ACTIVE_BUDGET_MS,
      localPreparationActiveCeilingMs: PREPARATION_ACTIVE_BUDGET_MS,
      faultFileActiveBudgetMs: 360_000,
      measurement: '250ms sampled allocated/apparent bytes; observed peak is a lower bound',
      destructionScope:
        'only the explicitly retired graph/Lucene fileset; retained fixture, owner objects, backups and media are not destroyed',
      phases: {},
      copies: [],
    };
    const phases = evidence.phases as Record<string, number>;
    const phaseDetails: Record<string, CampaignPhaseRecord> = {};
    evidence.phaseDetails = phaseDetails;
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
    const phase = <T>(
      name: string,
      work: () => T | Promise<T>,
      sample?: FixtureSampleCall,
    ): Promise<T> => attributedCampaignPhase(name, work, phases, phaseDetails, persist, sample);
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
      const restoreEvidenceSHA256: Record<string, string> = {};
      evidence.restoreEvidenceSHA256 = restoreEvidenceSHA256;
      const restoreTimings: RestorePreparationTiming[] = [];
      const autoRestoreInvocations: {
        target: string;
        activeMs: number;
        admissionWaitMs: number;
        wallMs: number;
      }[] = [];
      let autoRestoreInvocationWallMs = 0;
      for (const [index, stack] of stacks.entries()) {
        const restoreEvidencePath = join(
          root,
          '.artifacts',
          'fixture-restore',
          ids[index]!,
          'run.json',
        );
        const retainedRestorePath = join(evidenceDirectory, `restore-${index}.json`);
        if (!supplied) {
          await phase(`restore-${index}`, async () => {
            const invocationStarted = performance.now();
            const result = await runQaAdmissionChildAsync(
              root,
              'task',
              ['fixture:restore', '--', '--fixture', manifest.id, '--run-id', ids[index]!],
              PREPARATION_ACTIVE_BUDGET_MS,
            );
            const invocationWallMs = performance.now() - invocationStarted;
            writeFileSync(join(evidenceDirectory, `restore-command-${index}.log`), result.output, {
              mode: 0o600,
            });
            if (!result.ok || result.activeElapsedMs > PREPARATION_ACTIVE_BUDGET_MS) {
              if (readFileExists(restoreEvidencePath)) {
                const failedEvidence = readFileSync(restoreEvidencePath);
                writeFileSync(retainedRestorePath, failedEvidence, { mode: 0o600 });
                restoreEvidenceSHA256[ids[index]!] = digest(failedEvidence);
              }
              throw new Error(`fixture:restore failed; inspect restore-command-${index}.log`);
            }
            autoRestoreInvocationWallMs += invocationWallMs;
            autoRestoreInvocations.push({
              target: ids[index]!,
              activeMs: result.activeElapsedMs,
              admissionWaitMs: result.admissionWaitMs,
              wallMs: result.elapsedMs,
            });
          });
        }
        const restoreBytes = readFileSync(restoreEvidencePath, 'utf8');
        // Preserve original evidence even when parsing or qualification refuses it.
        writeFileSync(retainedRestorePath, restoreBytes, {
          mode: 0o600,
        });
        restoreEvidenceSHA256[ids[index]!] = digest(restoreBytes);
        const restore = JSON.parse(restoreBytes) as FixtureRestoreEvidence;
        restoreTimings.push(
          validateRestorePreparation(restore, {
            fixture: manifest.id,
            target: ids[index]!,
            profile,
            works: PROFILES[profile].works,
            samples: manifest.samples.length,
            generation: manifest.build.textIndexGeneration,
            sequence: manifest.importSequence,
          }),
        );
        restores.push(restore);
        evidence.restores = restores;
        evidence.restorePreparation = {
          routines: restoreTimings,
          aggregate: aggregateRestorePreparation(restoreTimings),
          autoInvocations: autoRestoreInvocations,
        };
        persist();
        const pins = await phase(`source-${index}-pins`, async () => {
          const inspected = await inspectFusekiState(stack.runner, stack.dockerEnv, stack.fuseki);
          assertPinnedState(
            inspected,
            repositoryPins(root, stack.dockerEnv, stack.stateVolume, [
              `${fixtureProject(manifest.id)}_fuseki_data`,
              stacks[1 - index]!.stateVolume,
            ]),
          );
          return inspected;
        });
        (evidence.copies as unknown[]).push({
          id: ids[index],
          stateVolume: stack.stateVolume,
          pins,
        });
        await phase(`source-${index}-work-count`, async () => {
          const count = await stack.fuseki.query(
            `SELECT (COUNT(?work) AS ?n) WHERE { GRAPH <${GRAPHS.current}> { ?work a <https://schema.org/CreativeWork> } }`,
          );
          expect(Number(count.results?.bindings[0]?.n?.value)).toBe(PROFILES[profile].works);
        });
        const owners = {
          access: new Pool({ connectionString: stack.apps.ACCESS_DATABASE_URL, max: 1 }),
          content: new Pool({ connectionString: stack.apps.CONTENT_DATABASE_URL, max: 1 }),
        };
        pools.push(owners.access, owners.content);
        sourceOwners.push(owners);
        await phase(`source-${index}-samples`, () =>
          checkSamples(stack.apps, manifest, owners, (call, read) =>
            phase(`source-${index}-sample-${call.index}-${call.operation}`, read, call),
          ),
        );
        await phase(`source-${index}-stop`, () => stack.runner.stop());
      }
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
      const preparation = localPreparationTiming(
        performance.now() - preparationStarted,
        autoRestoreInvocationWallMs,
        harnessSetupMs,
      );
      evidence.preparation = preparation;
      persist();
      if (preparation.activeMs > PREPARATION_ACTIVE_BUDGET_MS)
        throw new Error('Campaign-local active preparation exceeded 600000ms');

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
        // Compose merges command bytes and its own stderr progress messages.
        // Frame the file bytes rather than treating transport diagnostics as rows.
        const measurementsCapture = run(campaignFileRead('sizes.tsv'));
        const phasesCapture = run(campaignFileRead('phases.tsv'));
        const samplingCapture = run(campaignFileRead('sampling-errors.log'));
        writeFileSync(join(evidenceDirectory, `sizes-${index}-transport.log`), measurementsCapture);
        writeFileSync(join(evidenceDirectory, `phases-${index}-transport.log`), phasesCapture);
        writeFileSync(join(evidenceDirectory, `sampling-${index}-transport.log`), samplingCapture);
        const measurements = campaignFileBytes(measurementsCapture, 'sizes.tsv');
        const nativePhases = campaignFileBytes(phasesCapture, 'phases.tsv');
        // Retain malformed evidence too, so a refusal is directly diagnosable.
        writeFileSync(join(evidenceDirectory, `sizes-${index}.tsv`), measurements);
        writeFileSync(join(evidenceDirectory, `phases-${index}.tsv`), nativePhases);
        writeFileSync(
          join(evidenceDirectory, `sampling-errors-${index}.log`),
          campaignFileBytes(samplingCapture, 'sampling-errors.log'),
        );
        const summary = summarizeMeasurements(measurements, nativePhases);
        (evidence.copies as Record<string, unknown>[])[index]!.measurements = summary;
        const readyCapture = run(campaignFileRead('ready', `${CANDIDATE}/erasure-purge.ready`));
        writeFileSync(join(evidenceDirectory, `ready-${index}-transport.log`), readyCapture);
        const ready = campaignFileBytes(readyCapture, 'ready');
        writeFileSync(join(evidenceDirectory, `ready-${index}.txt`), ready);
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
            const receiptCapture = run(
              campaignFileRead(
                'retirement',
                '/fuseki/databases/rezics/erasure-purge.retired-qualification-retire',
              ),
            );
            writeFileSync(
              join(evidenceDirectory, `retirement-${index}-transport.log`),
              receiptCapture,
            );
            const receipt = campaignFileBytes(receiptCapture, 'retirement');
            writeFileSync(join(evidenceDirectory, `retirement-${index}.txt`), receipt);
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
      evidence.failureDetails = campaignFailure(error);
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

interface CampaignPhaseRecord {
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  error?: ReturnType<typeof campaignFailure>;
  sample?: FixtureSampleCall;
}

function campaignFailure(
  error: unknown,
  depth = 0,
): {
  name: string;
  message: string;
  cause?: ReturnType<typeof campaignFailure>;
} {
  const value = error instanceof Error ? error : undefined;
  return {
    name: (value?.name ?? 'Error').slice(0, 128),
    message: (value?.message ?? String(error)).slice(0, 1024),
    ...(value?.cause !== undefined && depth < 2
      ? { cause: campaignFailure(value.cause, depth + 1) }
      : {}),
  };
}

/** Persist a pending call before it runs; a deadline cannot leave an anonymous
 * timeout. Call names come only from bounded fixture phases and exact samples. */
async function attributedCampaignPhase<T>(
  name: string,
  work: () => T | Promise<T>,
  phases: Record<string, number>,
  details: Record<string, CampaignPhaseRecord>,
  persist: () => void,
  sample?: FixtureSampleCall,
): Promise<T> {
  const started = performance.now();
  const record: CampaignPhaseRecord = {
    status: 'running',
    startedAt: new Date().toISOString(),
    ...(sample ? { sample: { ...sample } } : {}),
  };
  details[name] = record;
  persist();
  try {
    const result = await work();
    record.status = 'succeeded';
    return result;
  } catch (error) {
    record.status = 'failed';
    record.error = campaignFailure(error);
    throw error;
  } finally {
    phases[name] = record.elapsedMs = Math.round(performance.now() - started);
    record.completedAt = new Date().toISOString();
    persist();
  }
}

interface RestorePreparationTiming {
  target: string;
  startedAt: string;
  completedAt: string;
  activeMs: number;
  admissionWaitMs: number;
  wallMs: number;
  clockSamplingOverheadMs: number;
}

function evidenceMilliseconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid restore preparation timing');
  return value;
}

function evidenceTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new Error('Invalid restore preparation timestamp');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new Error('Invalid restore preparation timestamp');
  return time;
}

function evidenceStrings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim() || /[\r\n\0]/.test(item)) ||
    new Set(value).size !== value.length
  )
    throw new Error('Incomplete restore preparation evidence');
  return [...value] as string[];
}

/** Validate the original routine's proof, independent of other restores or
 * current release compatibility. Its recorded generation stays literal. */
function validateRestorePreparation(
  restore: FixtureRestoreEvidence,
  expected: {
    fixture: string;
    target: string;
    profile: FixtureProfile;
    works: number;
    samples: number;
    generation: string;
    sequence: string;
  },
): RestorePreparationTiming {
  if (
    !restore ||
    typeof restore !== 'object' ||
    Array.isArray(restore) ||
    Object.hasOwn(restore, 'failure') ||
    restore.fixture !== expected.fixture ||
    restore.target !== expected.target ||
    restore.profile !== expected.profile ||
    restore.works !== expected.works ||
    restore.deadlineMs !== PREPARATION_ACTIVE_BUDGET_MS ||
    typeof restore.artifacts !== 'string' ||
    !restore.artifacts.startsWith('/') ||
    /[\r\n\0]/.test(restore.artifacts) ||
    !restore.artifacts.endsWith(`/fixture-restore/${expected.target}`)
  )
    throw new Error('Source lacks successful exact matching fixture:restore evidence');
  const activeMs = evidenceMilliseconds(restore.elapsedMs);
  const admissionWaitMs = evidenceMilliseconds(restore.admissionWaitMs);
  if (activeMs === 0) throw new Error('Invalid restore preparation timing');
  if (activeMs > PREPARATION_ACTIVE_BUDGET_MS)
    throw new Error('Individual restore active preparation exceeded 600000ms');
  const started = evidenceTimestamp(restore.startedAt),
    completed = evidenceTimestamp(restore.completedAt);
  const wallMs = completed - started;
  const accounted = evidenceMilliseconds(activeMs + admissionWaitMs);
  const clockSamplingOverheadMs = wallMs - accounted;
  // The producer samples its outer timestamp, budget constructor and completed
  // timestamp separately. Retain <=2ms sampling overhead; never adjust active/wait.
  if (
    !Number.isSafeInteger(wallMs) ||
    wallMs < 0 ||
    clockSamplingOverheadMs < 0 ||
    clockSamplingOverheadMs > 2
  )
    throw new Error('Restore active/admission/wall evidence does not reconcile');
  const phaseNames = ['compatibility', 'configure', 'copy', 'start', 'migrate', 'ready', 'smoke'];
  if (
    !restore.phases ||
    typeof restore.phases !== 'object' ||
    Array.isArray(restore.phases) ||
    !restore.copyMs ||
    typeof restore.copyMs !== 'object' ||
    Array.isArray(restore.copyMs)
  )
    throw new Error('Incomplete restore preparation evidence');
  const phaseMs = phaseNames.map((name) => evidenceMilliseconds(restore.phases[name]));
  if (phaseMs.reduce((sum, value) => sum + value, 0) > activeMs + phaseNames.length)
    throw new Error('Restore phase work exceeds recorded active preparation');
  for (const kind of ['postgres_data', 'fuseki_data', 'rustfs_data'])
    if (evidenceMilliseconds(restore.copyMs[kind]) > restore.phases.copy! + 1)
      throw new Error('Restore copy measurement exceeds its phase');
  const ready = evidenceStrings(restore.ready).sort();
  if (
    JSON.stringify(ready) !==
      JSON.stringify(
        ['account', 'access', 'content', 'relay', 'fuseki', 'lucene', 'rustfs'].sort(),
      ) ||
    restore.samples !== expected.samples ||
    restore.graph?.generation !== expected.generation ||
    restore.graph?.sequence !== expected.sequence ||
    restore.compatibility?.compatible !== true ||
    typeof restore.compatibility.engineChanged !== 'boolean' ||
    evidenceStrings(restore.compatibility.reasons).length !== 0 ||
    JSON.stringify(evidenceStrings(restore.compatibility.pendingMigrations).sort()) !==
      JSON.stringify(evidenceStrings(restore.appliedMigrations).sort())
  )
    throw new Error('Incomplete restore readiness or compatibility evidence');
  return {
    target: restore.target,
    startedAt: restore.startedAt,
    completedAt: restore.completedAt!,
    activeMs,
    admissionWaitMs,
    wallMs,
    clockSamplingOverheadMs,
  };
}

/** Aggregate observations are reported, never compared with a routine ceiling. */
function aggregateRestorePreparation(routines: readonly RestorePreparationTiming[]) {
  if (!routines.length) throw new Error('Missing restore preparation evidence');
  const sum = (field: 'activeMs' | 'admissionWaitMs' | 'wallMs') =>
    evidenceMilliseconds(routines.reduce((total, routine) => total + routine[field], 0));
  const externalSpanMs =
    Math.max(...routines.map((routine) => evidenceTimestamp(routine.completedAt))) -
    Math.min(...routines.map((routine) => evidenceTimestamp(routine.startedAt)));
  return {
    activeMs: sum('activeMs'),
    admissionWaitMs: sum('admissionWaitMs'),
    routineWallMs: sum('wallMs'),
    externalSpanMs,
    interRoutineGapMs: Math.max(0, externalSpanMs - sum('wallMs')),
    budgetScope: 'reported-only',
  };
}

function localPreparationTiming(
  localWallMs: number,
  qualifiedAutoRestoreWallMs: number,
  harnessActiveMs: number,
) {
  if (
    [localWallMs, qualifiedAutoRestoreWallMs, harnessActiveMs].some(
      (value) => !Number.isFinite(value) || value < 0,
    ) ||
    qualifiedAutoRestoreWallMs > localWallMs
  )
    throw new Error('Invalid campaign-local preparation timing');
  // The harness timestamp already excludes its admission. Only complete measured
  // auto-restore calls are excluded; probes, seed/custody work and local startup stay.
  return {
    activeMs: Math.round(localWallMs - qualifiedAutoRestoreWallMs + harnessActiveMs),
    localWallMs: Math.round(localWallMs),
    qualifiedAutoRestoreWallMs: Math.round(qualifiedAutoRestoreWallMs),
    harnessActiveMs: Math.round(harnessActiveMs),
    activeCeilingMs: PREPARATION_ACTIVE_BUDGET_MS,
  };
}

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
# A directory can disappear while du walks a compacting generation. Preserve
# the diagnostic and emit an invalid cell; an existent failed read is never zero.
: > ${MEASURE}/sampling-errors.log
sample() {
  size() {
    if [ ! -d "$2" ]; then echo 0; return; fi
    if value=$(du "$1" "$2" 2>> ${MEASURE}/sampling-errors.log); then
      printf '%s\\n' "$value" | cut -f1
    else
      printf 'du-error %s %s %s\\n' "$(date +%s%3N)" "$1" "$2" >> ${MEASURE}/sampling-errors.log
      printf '%s\\n' du-error
    fi
  }
  alloc() { size -sk "$1"; }
  apparent() { size -sb "$1"; }
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

type CampaignFile = 'sizes.tsv' | 'phases.tsv' | 'sampling-errors.log' | 'ready' | 'retirement';

function campaignFileRead(file: CampaignFile, path = `${MEASURE}/${file}`): string {
  return `printf '%s\\n' 'REZICS_CAMPAIGN_EVIDENCE_BEGIN:${file}'
cat ${path}
printf '%s\\n' 'REZICS_CAMPAIGN_EVIDENCE_END:${file}'`;
}

function campaignFileBytes(capture: string, file: CampaignFile): string {
  const begin = `REZICS_CAMPAIGN_EVIDENCE_BEGIN:${file}\n`;
  const end = `REZICS_CAMPAIGN_EVIDENCE_END:${file}\n`;
  if (capture.split(begin).length !== 2 || capture.split(end).length !== 2)
    throw new Error(`Invalid ${file} measurement transport framing`);
  const start = capture.indexOf(begin) + begin.length;
  const finish = capture.indexOf(end);
  if (finish < start || (finish > start && capture[finish - 1] !== '\n'))
    throw new Error(`Invalid ${file} measurement transport framing`);
  return capture.slice(start, finish);
}

function summarizeMeasurements(sizes: string, phases: string) {
  const rows = (sizes.endsWith('\n') ? sizes.slice(0, -1) : sizes)
    .split('\n')
    .map((line, index) => {
      const columns = line.trim().split(/\s+/);
      const values = columns.map(Number);
      if (
        columns.length !== 16 ||
        columns.some((value) => !/^\d+$/.test(value)) ||
        values.some((value) => !Number.isSafeInteger(value) || value < 0)
      )
        throw new Error(
          `Invalid sampled disk evidence at row ${index + 1}: expected 16 nonnegative integer columns, received ${JSON.stringify(line)}`,
        );
      return values;
    });
  if (rows.length < 2)
    throw new Error('Invalid sampled disk evidence: at least two samples required');
  if (rows.some((row, index) => index > 0 && row[0]! < rows[index - 1]![0]!))
    throw new Error('Invalid sampled disk evidence: sample timestamps move backwards');
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

const measuredPhaseExample = [
  'copy start 1000',
  'copy end 1200 0',
  'compact start 1200',
  'compact end 1500 0',
  'index start 1500',
  'index end 1600 0',
].join('\n');
const measuredRowsExample =
  [
    '1000 80 81920 60 61440 40 40960 20 20480 0 0 0 0 0 0 200',
    '1250 180 184320 60 61440 40 40960 20 20480 100 102400 80 81920 20 20480 100',
    '1500 150 153600 60 61440 40 40960 20 20480 70 71680 50 51200 20 20480 130',
  ].join('\n') + '\n';

test('OPS10: campaign measurement keeps exact rows apart from Compose transport progress', () => {
  const capture = `REZICS_CAMPAIGN_EVIDENCE_BEGIN:sizes.tsv\n${measuredRowsExample}REZICS_CAMPAIGN_EVIDENCE_END:sizes.tsv\n Container qualification-fuseki-run Creating\n Container qualification-fuseki-run Created\n`;
  const rows = campaignFileBytes(capture, 'sizes.tsv');
  expect(rows).toBe(measuredRowsExample);
  for (const file of ['ready', 'retirement'] as const) {
    const payload = `campaign-sha256=${'a'.repeat(64)}\nsource-sha256=${'b'.repeat(64)}\n`;
    const transport = `REZICS_CAMPAIGN_EVIDENCE_BEGIN:${file}\n${payload}REZICS_CAMPAIGN_EVIDENCE_END:${file}\n Container transport Created\n`;
    expect(campaignFileBytes(transport, file)).toBe(payload);
    expect(digest(campaignFileBytes(transport, file))).toBe(digest(payload));
  }
  const summary = summarizeMeasurements(rows, measuredPhaseExample);
  expect(summary.samples).toBe(3);
  expect(summary.phasesMs).toEqual({ copy: 200, compact: 300, index: 100 });
  expect(summary.sourceAllocatedBytes).toBe(60 * 1024);
  expect(summary.candidateAllocatedBytes).toBe(70 * 1024);
  expect(summary.candidateGraphAllocatedBytes).toBe(50 * 1024);
  expect(summary.candidateIndexAllocatedBytes).toBe(20 * 1024);
  expect(summary.peakVolumeAllocatedBytes).toBe(180 * 1024);
  expect(summary.peakVolumeApparentBytes).toBe(184320);
  expect(summary.minimumFilesystemFreeBytes).toBe(100 * 1024);
  expect(summary.maximumObservedSampleGapMs).toBe(250);
});

test('OPS10: campaign measurement refuses malformed actual rows and framing without dropping evidence', () => {
  for (const row of [
    '',
    '1250 1 2',
    '1250 -1 2 3 4 5 6 7 8 9 10 11 12 13 14 15',
    '1250 1.5 2 3 4 5 6 7 8 9 10 11 12 13 14 15',
    '1250 du-error 2 3 4 5 6 7 8 9 10 11 12 13 14 15',
    ' Container unexpected-in-file Created',
  ]) {
    const rows = measuredRowsExample.replace(measuredRowsExample.split('\n')[1]!, row);
    const capture = `REZICS_CAMPAIGN_EVIDENCE_BEGIN:sizes.tsv\n${rows}REZICS_CAMPAIGN_EVIDENCE_END:sizes.tsv\n Container transport Created\n`;
    expect(campaignFileBytes(capture, 'sizes.tsv')).toBe(rows);
    expect(() =>
      summarizeMeasurements(campaignFileBytes(capture, 'sizes.tsv'), measuredPhaseExample),
    ).toThrow('at row 2');
  }
  for (const capture of [
    measuredRowsExample,
    `REZICS_CAMPAIGN_EVIDENCE_END:sizes.tsv\nREZICS_CAMPAIGN_EVIDENCE_BEGIN:sizes.tsv\n${measuredRowsExample}`,
    `REZICS_CAMPAIGN_EVIDENCE_BEGIN:sizes.tsv\n${measuredRowsExample}REZICS_CAMPAIGN_EVIDENCE_END:sizes.tsv\nREZICS_CAMPAIGN_EVIDENCE_END:sizes.tsv\n`,
  ])
    expect(() => campaignFileBytes(capture, 'sizes.tsv')).toThrow('transport framing');
  expect(() =>
    summarizeMeasurements(measuredRowsExample.replace('1250 ', '500 '), measuredPhaseExample),
  ).toThrow('timestamps move backwards');
});

test('OPS10: campaign measurement uses real du bytes and rejects an existent failed du read', () => {
  const directory = mkdtempSync(join(root, '.temp', 'erasure-campaign-measurement-'));
  try {
    for (const path of ['rezics/tdb2', 'rezics/lucene', 'campaign-measure'])
      mkdirSync(join(directory, path), { recursive: true });
    writeFileSync(join(directory, 'rezics/tdb2', 'sample'), Buffer.alloc(4096, 7));
    const build = measuredBuild().replaceAll('/fuseki/databases', directory);
    const sampler = build.slice(build.indexOf(': > '), build.indexOf('\nsample\n('));
    const run = (failed: boolean) =>
      spawnSync(
        'sh',
        [
          '-ec',
          `${sampler}
${failed ? "du() { printf '%s\\n' 'du: sample failure' >&2; return 1; }" : ''}
sample
sample
${campaignFileRead('sizes.tsv').replaceAll('/fuseki/databases', directory)}`,
        ],
        { encoding: 'utf8', timeout: 10_000 },
      );
    const measured = run(false);
    expect(measured.status).toBe(0);
    const summary = summarizeMeasurements(
      campaignFileBytes(measured.stdout, 'sizes.tsv'),
      measuredPhaseExample,
    );
    expect(summary.samples).toBe(2);
    expect(summary.sourceGraphApparentBytes).toBeGreaterThanOrEqual(4096);
    expect(summary.candidateAllocatedBytes).toBe(0);
    expect(readFileSync(join(directory, 'campaign-measure/sampling-errors.log'), 'utf8')).toBe('');
    rmSync(join(directory, 'campaign-measure/sizes.tsv'));
    const failed = run(true);
    expect(failed.status).toBe(0);
    expect(() =>
      summarizeMeasurements(campaignFileBytes(failed.stdout, 'sizes.tsv'), measuredPhaseExample),
    ).toThrow('at row 1');
    const errors = readFileSync(join(directory, 'campaign-measure/sampling-errors.log'), 'utf8');
    expect(errors).toContain('du: sample failure');
    expect(errors).toContain('du-error');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Literal retained539/fa restore observations; never rewritten for current pins.
const recordedCampaignRestores: FixtureRestoreEvidence[] = [
  JSON.parse(`{
  "fixture": "fx-medium-605f041f8150",
  "target": "fixture-quiet-medium-a",
  "profile": "medium",
  "works": 100000,
  "startedAt": "2026-10-07T19:22:24.082Z",
  "deadlineMs": 600000,
  "phases": {
    "compatibility": 225,
    "configure": 5,
    "copy": 235219,
    "start": 31190,
    "migrate": 4763,
    "ready": 396,
    "smoke": 1472
  },
  "artifacts": "/home/edge/projects/rezics/rezics-next/.temp/worktrees/g-1344/.artifacts/fixture-restore/fixture-quiet-medium-a",
  "compatibility": {
    "compatible": true,
    "reasons": [],
    "pendingMigrations": [],
    "engineChanged": false
  },
  "copyMs": {
    "fuseki_data": 14637,
    "postgres_data": 21263,
    "rustfs_data": 234575
  },
  "appliedMigrations": [],
  "graph": {
    "generation": "urn:rezics:text-index-generation:a3f55b32-438e-4e1f-8661-2befca1b2a0d",
    "sequence": "0"
  },
  "ready": [
    "account",
    "access",
    "content",
    "relay",
    "fuseki",
    "lucene",
    "rustfs"
  ],
  "samples": 3,
  "elapsedMs": 273668,
  "admissionWaitMs": 112988,
  "completedAt": "2026-10-07T19:28:50.738Z"
}`),
  JSON.parse(`{
  "fixture": "fx-medium-605f041f8150",
  "target": "fixture-quiet-medium-b",
  "profile": "medium",
  "works": 100000,
  "startedAt": "2026-10-07T19:32:13.934Z",
  "deadlineMs": 600000,
  "phases": {
    "compatibility": 229,
    "configure": 5,
    "copy": 329589,
    "start": 20526,
    "migrate": 804,
    "ready": 588,
    "smoke": 354
  },
  "artifacts": "/home/edge/projects/rezics/rezics-next/.temp/worktrees/g-1344/.artifacts/fixture-restore/fixture-quiet-medium-b",
  "compatibility": {
    "compatible": true,
    "reasons": [],
    "pendingMigrations": [],
    "engineChanged": false
  },
  "copyMs": {
    "fuseki_data": 18706,
    "postgres_data": 37348,
    "rustfs_data": 327905
  },
  "appliedMigrations": [],
  "graph": {
    "generation": "urn:rezics:text-index-generation:a3f55b32-438e-4e1f-8661-2befca1b2a0d",
    "sequence": "0"
  },
  "ready": [
    "account",
    "access",
    "content",
    "relay",
    "fuseki",
    "lucene",
    "rustfs"
  ],
  "samples": 3,
  "elapsedMs": 352561,
  "admissionWaitMs": 4931,
  "completedAt": "2026-10-07T19:38:11.426Z"
}`),
];
const recordedRestoreExpectation = (target: string) => ({
  fixture: 'fx-medium-605f041f8150',
  target,
  profile: 'medium' as const,
  works: 100_000,
  samples: 3,
  generation: 'urn:rezics:text-index-generation:a3f55b32-438e-4e1f-8661-2befca1b2a0d',
  sequence: '0',
});

test('OPS10: campaign source attribution persists the exact pending call and original timeout', async () => {
  const phases: Record<string, number> = {},
    details: Record<string, CampaignPhaseRecord> = {};
  const writes: Record<string, CampaignPhaseRecord>[] = [];
  const persist = () => {
    writes.push(structuredClone(details));
  };
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  let observed: unknown;
  try {
    await attributedCampaignPhase(
      'source-0-work-count',
      async () => {
        expect(writes.at(-1)!['source-0-work-count']!.status).toBe('running');
        throw timeout;
      },
      phases,
      details,
      persist,
    );
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(timeout);
  expect(details['source-0-work-count']).toMatchObject({
    status: 'failed',
    error: { name: 'TimeoutError', message: 'The operation timed out.' },
  });
  expect(details['source-0-work-count']!.startedAt).toMatch(/^\d{4}-/);
  expect(details['source-0-work-count']!.completedAt).toMatch(/^\d{4}-/);
  expect(phases['source-0-work-count']).toBeGreaterThanOrEqual(0);
});

test('OPS10: campaign source attribution retains nested sample identity, success and bounded causes', async () => {
  const phases: Record<string, number> = {},
    details: Record<string, CampaignPhaseRecord> = {};
  const snapshots: Record<string, CampaignPhaseRecord>[] = [];
  const persist = () => {
    snapshots.push(structuredClone(details));
  };
  const timeout = new DOMException('network deadline', 'TimeoutError');
  const error = new Error('sample failed', { cause: timeout });
  await expect(
    attributedCampaignPhase(
      'source-0-samples',
      () =>
        attributedCampaignPhase(
          'source-0-sample-50000-main-revision',
          () => {
            throw error;
          },
          phases,
          details,
          persist,
          { index: 50_000, operation: 'main-revision', target: 'urn:rezics:test:main-revision' },
        ),
      phases,
      details,
      persist,
    ),
  ).rejects.toBe(error);
  expect(details['source-0-sample-50000-main-revision']).toMatchObject({
    status: 'failed',
    sample: { index: 50_000, operation: 'main-revision', target: 'urn:rezics:test:main-revision' },
    error: {
      name: 'Error',
      message: 'sample failed',
      cause: { name: 'TimeoutError', message: 'network deadline' },
    },
  });
  expect(
    snapshots.some(
      (snapshot) =>
        snapshot['source-0-samples']?.status === 'running' &&
        snapshot['source-0-sample-50000-main-revision']?.status === 'running',
    ),
  ).toBe(true);
  expect(
    await attributedCampaignPhase('source-1-work-count', () => 100_000, phases, details, persist),
  ).toBe(100_000);
  expect(details['source-1-work-count']!.status).toBe('succeeded');
  const cycle = new Error('x'.repeat(2_000));
  cycle.cause = cycle;
  const failure = campaignFailure(cycle);
  expect(failure.message).toHaveLength(1024);
  expect(failure.cause?.cause?.cause).toBeUndefined();
});

test('OPS10: campaign preparation qualifies each literal restore independently and retains ungated aggregates', () => {
  const original = JSON.stringify(recordedCampaignRestores);
  const routines = recordedCampaignRestores.map((restore) =>
    validateRestorePreparation(restore, recordedRestoreExpectation(restore.target)),
  );
  expect(
    routines.map((routine) => [routine.activeMs, routine.admissionWaitMs, routine.wallMs]),
  ).toEqual([
    [273_668, 112_988, 386_656],
    [352_561, 4_931, 357_492],
  ]);
  expect(aggregateRestorePreparation(routines)).toEqual({
    activeMs: 626_229,
    admissionWaitMs: 117_919,
    routineWallMs: 744_148,
    externalSpanMs: 947_344,
    interRoutineGapMs: 203_196,
    budgetScope: 'reported-only',
  });
  expect(JSON.stringify(recordedCampaignRestores)).toBe(original);
});

test('OPS10: campaign preparation rejects failed, malformed, incomplete and individually over-budget restore evidence', () => {
  const changes: ((restore: FixtureRestoreEvidence) => void)[] = [
    (restore) => {
      restore.elapsedMs = 600_001;
    },
    (restore) => {
      delete restore.elapsedMs;
    },
    (restore) => {
      restore.elapsedMs = Number.NaN;
    },
    (restore) => {
      restore.elapsedMs = Number.POSITIVE_INFINITY;
    },
    (restore) => {
      restore.elapsedMs = -1;
    },
    (restore) => {
      restore.elapsedMs = 273_668.5;
    },
    (restore) => {
      restore.elapsedMs = 0;
    },
    (restore) => {
      delete restore.admissionWaitMs;
    },
    (restore) => {
      restore.admissionWaitMs = -1;
    },
    (restore) => {
      restore.admissionWaitMs = 4.5;
    },
    (restore) => {
      restore.admissionWaitMs = 0;
    },
    (restore) => {
      restore.startedAt = '';
    },
    (restore) => {
      restore.startedAt = ' 2026-10-07T19:22:24.082Z';
    },
    (restore) => {
      restore.startedAt = '2026-02-30T19:22:24.082Z';
    },
    (restore) => {
      delete restore.completedAt;
    },
    (restore) => {
      restore.completedAt = '';
    },
    (restore) => {
      restore.completedAt = '2026-10-07T19:22:00.000Z';
    },
    (restore) => {
      restore.completedAt = '2026-10-07T19:28:51.738Z';
    },
    (restore) => {
      restore.failure = '';
    },
    (restore) => {
      restore.failure = 'restore interrupted';
    },
    (restore) => {
      restore.target = 'fixture-other';
    },
    (restore) => {
      restore.fixture = 'fx-medium-000000000000';
    },
    (restore) => {
      restore.profile = 'small';
    },
    (restore) => {
      restore.works = 1_000;
    },
    (restore) => {
      restore.deadlineMs = 900_000;
    },
    (restore) => {
      restore.artifacts = '/fixture-restore/fixture-other';
    },
    (restore) => {
      delete restore.phases.copy;
    },
    (restore) => {
      restore.phases.start = -1;
    },
    (restore) => {
      restore.phases.copy = 600_000;
    },
    (restore) => {
      delete restore.copyMs;
    },
    (restore) => {
      delete restore.copyMs!.rustfs_data;
    },
    (restore) => {
      restore.copyMs!.rustfs_data = 600_000;
    },
    (restore) => {
      delete restore.ready;
    },
    (restore) => {
      restore.ready = restore.ready!.filter((owner) => owner !== 'lucene');
    },
    (restore) => {
      restore.ready!.push('account');
    },
    (restore) => {
      restore.samples = 2;
    },
    (restore) => {
      delete restore.graph;
    },
    (restore) => {
      restore.graph!.generation = 'urn:rezics:text-index-generation:foreign';
    },
    (restore) => {
      restore.graph!.sequence = '1';
    },
    (restore) => {
      restore.compatibility!.compatible = false;
    },
    (restore) => {
      restore.compatibility!.reasons = ['changed owner'];
    },
    (restore) => {
      delete restore.appliedMigrations;
    },
    (restore) => {
      restore.compatibility!.pendingMigrations = ['unapplied.sql'];
    },
  ];
  for (const change of changes) {
    const restore = structuredClone(recordedCampaignRestores[0]!);
    change(restore);
    expect(() =>
      validateRestorePreparation(restore, recordedRestoreExpectation('fixture-quiet-medium-a')),
    ).toThrow();
  }
});

test('OPS10: campaign preparation excludes only separately qualified auto restore calls from local work', () => {
  const setup = localPreparationTiming(900_000, 744_148, 12_000);
  expect(setup).toEqual({
    activeMs: 167_852,
    localWallMs: 900_000,
    qualifiedAutoRestoreWallMs: 744_148,
    harnessActiveMs: 12_000,
    activeCeilingMs: 600_000,
  });
  // Supplied records'947.344s span is reported separately; no child ran here.
  expect(localPreparationTiming(155_852, 0, 12_000).activeMs).toBe(167_852);
  const overBudget = localPreparationTiming(1_345_000, 744_148, 12_000);
  expect(overBudget.activeMs).toBeGreaterThan(600_000);
  // Actual source probes/seeding/custody/startup stay in the600ACTIVE local gate.
  for (const [wall, restore, harness] of [
    [-1, 0, 0],
    [1, 2, 0],
    [1, 0, -1],
    [Number.NaN, 0, 0],
    [1, Number.POSITIVE_INFINITY, 0],
  ])
    expect(() => localPreparationTiming(wall!, restore!, harness!)).toThrow();
});

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
