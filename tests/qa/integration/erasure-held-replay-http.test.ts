import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { docker } from '../../../scripts/operations/search-state.ts';
import {
  FusekiClient,
  type CommandEnvelope,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import {
  buildHeldGraphErasureCommand,
  GraphErasureConflict,
  graphErasureReceipt,
  heldErasureMaintenanceClient,
  heldGraphLineageSequence,
  probeHeldGraphErasureProof,
  readGraphErasureProof,
  suppressGraphContentRevisions,
  suppressHeldGraphContentRevisions,
  type HeldGraphErasureAuthorization,
  type HeldGraphErasureProof,
} from '../../../services/main/src/modules/erasure/graph.ts';
import {
  journalErasure,
  readErasure,
  sha256,
} from '../../../services/main/src/modules/erasure/journal.ts';
import {
  assertGraphErasure,
  graphLineageSequence,
  replayGraphErasure,
} from '../../../services/main/src/modules/erasure/replay-graph.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import {
  pinnedImage,
  qaStack,
  standaloneFuseki,
  type StandaloneFuseki,
} from '../fault-recovery/search-ops-support.ts';

const RV = 'https://rezics.com/vocab/';
const PUBLIC = 'urn:rezics:search:public';
const PRIVATE = 'urn:rezics:search:private';
const REVISIONS = 'urn:rezics:graph:revisions';
const CONTROL = 'urn:rezics:graph:control';
const KEY = '3'.repeat(64),
  MAINTENANCE = '4'.repeat(64),
  ORDINARY = '5'.repeat(64);
const revision = (id: string) => `urn:rezics:content:revision:${id}`;
const unit = (n: number) => `urn:rezics:held-http:unit:${n}`;

function resign(command: CommandEnvelope, change: (fields: unknown[]) => void): CommandEnvelope {
  const fields = JSON.parse(command.titleAdmission!.payload) as unknown[];
  change(fields);
  fields[3] = sha256(command.update);
  const payload = JSON.stringify(fields);
  return {
    ...command,
    titleAdmission: {
      payload,
      signature: createHmac('sha256', KEY).update(payload).digest('hex'),
    },
  };
}

/** Uses the product endpoint and actual native policy. A supplied image is an
 * isolated candidate, never evidence that its Core inputs are activated on Main. */
test('OPS10: real held native HTTP replay authenticates exact bytes, preserves the cut and rechecks interrupted outcomes', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.ACCOUNT_RELAY_DATABASE_URL)
    throw new Error('Run through the isolated QA integration tier');
  const stack = qaStack(runId);
  const image = Bun.env.REZICS_HELD_ERASURE_IMAGE ?? pinnedImage();
  const imageId = docker(
    ['image', 'inspect', '--format', '{{.Id}}', image],
    stack.dockerEnv,
  ).trim();
  const evidence = join(Bun.env.REZICS_QA_ARTIFACT_DIR!, 'held-erasure-http');
  mkdirSync(evidence, { recursive: true });
  const manifestPath = Bun.env.REZICS_HELD_ERASURE_SOURCE_MANIFEST;
  writeFileSync(
    join(evidence, 'image.json'),
    JSON.stringify(
      {
        image,
        imageId,
        status: manifestPath
          ? 'isolated frozen candidate; Main activation pending'
          : 'pinned test image',
        ...(manifestPath ? { source: JSON.parse(readFileSync(manifestPath, 'utf8')) } : {}),
      },
      null,
      2,
    ),
  );
  const name = `rezics-held-http-${randomUUID().slice(0, 12)}`;
  const volume = `${name}-state`;
  const databases = await cloneQaAccountAccessDatabases(runId);
  const access = new Pool({ connectionString: databases.urls.access, max: 1 });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 1 });
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const prior = { dataEpoch: randomUUID(), routingEpoch: '1' };
  const next = { dataEpoch: randomUUID(), routingEpoch: '2' };
  const secrets = {
    FUSEKI_MAINTENANCE_TOKEN: MAINTENANCE,
    FUSEKI_COMMAND_TOKEN: ORDINARY,
    FUSEKI_TITLE_ADMISSION_KEY: KEY,
  };
  let source: StandaloneFuseki | undefined, restored: StandaloneFuseki | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  const responses: { label: string; status: number; body: unknown }[] = [];
  try {
    const entry = await journalErasure(relay, {
      operationId: `held-http-${randomUUID()}`,
      requestDigest: sha256(JSON.stringify(ids.slice(0, 2))),
      kind: 'revision',
      principalId: randomUUID(),
      admissionId: randomUUID(),
      authorityEpoch: '0',
      targets: ids.slice(0, 2).map((ref) => ({ kind: 'content_revision', ref })),
    });
    source = await standaloneFuseki(stack.dockerEnv, { name, image, volume, secrets });
    const sourceCommands: CommandEnvelope[] = [];
    const originalClient = new (class extends FusekiClient {
      override async command(command: CommandEnvelope) {
        sourceCommands.push(command);
        return super.command(command);
      }
    })(source.url, MAINTENANCE, ORDINARY);
    await initializeFreshGraph(originalClient, prior);
    source.runner.stop();
    // A tiny offline fixture on an actually stopped owner; no product raw-update
    // endpoint, manufactured stop marker, or mutation of a retained backup.
    const seed = [
      ...ids
        .slice(0, 2)
        .flatMap((id, n) => [
          `<${unit(n)}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}MatchUnit> <${n ? PRIVATE : PUBLIC}> .`,
          `<${unit(n)}> <${RV}revision> <${revision(id)}> <${n ? PRIVATE : PUBLIC}> .`,
          `<${unit(n)}> <${RV}${n ? 'privateSearchBody' : 'searchBody'}> "forbidden held payload"@en <${n ? PRIVATE : PUBLIC}> .`,
        ]),
      ...[PUBLIC, PRIVATE].flatMap((graph, n) => [
        `<${unit(n + 10)}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}MatchUnit> <${graph}> .`,
        `<${unit(n + 10)}> <${RV}revision> <${revision(ids[4]!)}> <${graph}> .`,
        `<${unit(n + 10)}> <${RV}${n ? 'privateSearchBody' : 'searchBody'}> "retained unrelated payload"@en <${graph}> .`,
      ]),
      `<${revision(ids[2]!)}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}ErasedRevision> <${REVISIONS}> .`,
      `<${revision(ids[2]!)}> <${RV}erasureEpoch> "${entry.erasureEpoch}"^^<http://www.w3.org/2001/XMLSchema#integer> <${REVISIONS}> .`,
      `<${unit(3)}> <${RV}revision> <${revision(ids[3]!)}> <${PUBLIC}> .`,
      `<${unit(3)}> <${RV}contentRevision> <${revision(ids[4]!)}> <${PUBLIC}> .`,
      `<urn:rezics:held-http:manifest> <${RV}payloadDigest> "${'a'.repeat(64)}" <${REVISIONS}> .`,
      `<urn:rezics:held-http:model> <${RV}manifest> <urn:rezics:sha256:${'b'.repeat(64)}> <${REVISIONS}> .`,
    ].join('\n');
    writeFileSync(join(evidence, 'source-seed.nq'), seed);
    source.runner.offline(`test -f /fuseki/databases/rezics/clean-stop
exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /fuseki/databases/held-http-seed.nq <<'NQ'
${seed}
NQ
java -Xmx512m -cp "$FUSEKI_HOME/fuseki-server.jar" tdb2.tdbloader --loader=phased --loc=/fuseki/databases/rezics/tdb2 /fuseki/databases/held-http-seed.nq
java -Xmx512m -cp "/fuseki/extra/fuseki-command.jar:$FUSEKI_HOME/fuseki-server.jar" com.rezics.jena.ErasureTextIndexer --desc=/fuseki/fuseki-text.ttl
mkdir -p /fuseki/databases/held-http-copy/databases /fuseki/databases/held-http-copy/extra
cp -R /fuseki/databases/rezics /fuseki/databases/held-http-copy/databases/rezics
cp /fuseki/extra/fuseki-command.jar /fuseki/databases/held-http-copy/extra/fuseki-command.jar
cp -R /fuseki/profiles /fuseki/databases/held-http-copy/profiles
cp /fuseki/fuseki-text.ttl /fuseki/databases/held-http-copy/fuseki-text.ttl`);
    await source.runner.start();
    await suppressGraphContentRevisions(
      originalClient,
      prior,
      entry.erasureId,
      entry.erasureEpoch,
      ids.slice(0, 2),
    );
    const original = await readGraphErasureProof(
      originalClient,
      prior,
      entry.erasureId,
      entry.erasureEpoch,
      ids.slice(0, 2),
    );
    expect(BigInt(original.sequence)).toBeGreaterThan(0n);
    const originalCommand = sourceCommands.find((command) => command.receipt === original.receipt)!;
    expect(originalCommand).toBeDefined();
    writeFileSync(
      join(evidence, 'ordinary-original-command.json'),
      JSON.stringify(originalCommand),
    );
    writeFileSync(join(evidence, 'retained-original-proof.json'), JSON.stringify(original));
    restored = await standaloneFuseki(stack.dockerEnv, {
      name: `${name}-copy`,
      image,
      volume,
      secrets: { ...secrets, FUSEKI_BASE: '/fuseki/databases/held-http-copy' },
      command: [
        'sh',
        '-ec',
        'cd "$FUSEKI_BASE" && exec "$FUSEKI_HOME/fuseki-server" --port=3030 --no-cors --timeout=10000 --config="$FUSEKI_BASE/fuseki-text.ttl"',
      ],
    });
    const graph = new FusekiClient(restored.url, MAINTENANCE, ORDINARY);
    await cutoverRestoredGraphLineage(graph, { prior: { ...prior, sequence: '0' }, next });
    restored.runner.stop();
    // A prior reconciliation cursor may already exist when erasure replay runs.
    // Seed it under the stopped copy's sole owner, then prove it stays exact.
    restored.runner.offline(`state=/fuseki/databases/held-http-copy/databases/rezics
test -f "$state/clean-stop"
exec 9>>"$state/owner.lock"
flock -n 9
cat > /fuseki/databases/held-http-cursor.nq <<'NQ'
<urn:rezics:restore:${next.dataEpoch}> <${RV}reconciledPriorSequence> "5"^^<http://www.w3.org/2001/XMLSchema#integer> <${CONTROL}> .
NQ
java -Xmx512m -cp "$FUSEKI_HOME/fuseki-server.jar" tdb2.tdbloader --loader=phased --loc="$state/tdb2" /fuseki/databases/held-http-cursor.nq`);
    await restored.runner.start();
    const generation = await engageAccessRecoveryFence(access);
    const held: HeldGraphErasureProof = {
      cut: {
        ...next,
        restoreCutover: `urn:rezics:restore:${next.dataEpoch}`,
        priorDataEpoch: prior.dataEpoch,
        priorSequence: '0',
      },
      accessHoldGeneration: generation,
      revisionIds: ids.slice(0, 2),
      original,
    };
    const snapshot = async () =>
      (await graph.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o'))
        .results!.bindings;
    const controls = async () =>
      (
        await graph.query(
          `SELECT ?s ?p ?o WHERE { GRAPH <${CONTROL}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
        )
      ).results!.bindings;
    const text = async (graphName: string, field: string, word: string) =>
      (
        await graph.query(`PREFIX rv: <${RV}> PREFIX text: <http://jena.apache.org/text#>
SELECT ?unit WHERE { GRAPH <${graphName}> { (?unit ?score) text:query (rv:${field} '${word}' 10) } }`)
      ).results!.bindings.map((row) => row.unit!.value);
    const beforeControl = await controls();
    expect(beforeControl).toContainEqual(
      expect.objectContaining({
        p: { type: 'uri', value: `${RV}reconciledPriorSequence` },
        o: { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#integer', value: '5' },
      }),
    );
    expect(beforeControl).toContainEqual(
      expect.objectContaining({
        s: { type: 'uri', value: 'urn:rezics:stream:main-rdf' },
        p: { type: 'uri', value: `${RV}streamSequence` },
        o: { type: 'literal', datatype: 'http://www.w3.org/2001/XMLSchema#integer', value: '0' },
      }),
    );
    expect(await text(PUBLIC, 'searchBody', 'forbidden')).toContain(unit(0));
    expect(await text(PRIVATE, 'privateSearchBody', 'forbidden')).toContain(unit(1));
    expect(await graphLineageSequence(graph, next)).toBeNull();
    expect(await heldGraphLineageSequence(graph, held.cut)).toBe('0');
    const good = buildHeldGraphErasureCommand(
      entry.erasureId,
      entry.erasureEpoch,
      held.revisionIds,
      held,
      [
        { graph: PUBLIC, unit: unit(0) },
        { graph: PRIVATE, unit: unit(1) },
      ],
      KEY,
    );
    expect(JSON.parse(good.titleAdmission!.payload)).toHaveLength(17);
    writeFileSync(join(evidence, 'initial-command.json'), JSON.stringify(good, null, 2));
    const post = async (label: string, command: CommandEnvelope, token = MAINTENANCE) => {
      const response = await fetch(new URL('command', restored!.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(command),
      });
      const raw = await response.text();
      const body: unknown = raw.startsWith('{') ? JSON.parse(raw) : raw;
      responses.push({ label, status: response.status, body });
      return { status: response.status, body };
    };
    const baseline = await snapshot();
    await expect(
      heldErasureMaintenanceClient(restored.url, MAINTENANCE).command(originalCommand),
    ).rejects.toThrow('capability rejected');
    expect(await heldErasureMaintenanceClient(source.url, MAINTENANCE).command(good)).toMatchObject(
      { status: 'invalid' },
    );
    expect((await post('ordinary-bearer', good, ORDINARY)).status).toBe(403);
    expect((await post('missing-bearer', good, '')).status).toBe(403);
    for (const [label, command] of [
      [
        'foreign-lineage',
        resign(good, (f) => {
          f[4] = randomUUID();
        }),
      ],
      [
        'stale-prior-cut',
        resign(good, (f) => {
          f[16] = '1';
        }),
      ],
      [
        'expired-proof',
        resign(good, (f) => {
          f[14] = '2000-01-01T00:00:00Z';
        }),
      ],
      [
        'foreign-target-proof',
        resign(good, (f) => {
          f[10] = [revision(ids[4]!)];
        }),
      ],
      [
        'partial-unit-delete',
        resign(
          {
            ...good,
            update: good.update.replace(
              `${unit(1)}> ?p1 ?o1`,
              `${unit(1)}> rv:privateSearchBody ?o1`,
            ),
          },
          () => {},
        ),
      ],
    ] as const) {
      const rejected = await post(label, command);
      if (label === 'partial-unit-delete')
        expect(rejected).toMatchObject({ status: 400, body: { status: 'bad-request' } });
      else expect(rejected).toMatchObject({ status: 200, body: { status: 'invalid' } });
      expect(await snapshot()).toEqual(baseline);
    }
    for (const [label, targets, units] of [
      ['fractured-tombstones', [ids[2]!, ids[3]!], []],
      ['mixed-unit-references', [ids[3]!], [{ graph: PUBLIC, unit: unit(3) }]],
    ] as const) {
      const id = randomUUID();
      const malformed = {
        ...held,
        revisionIds: targets,
        original: { ...original, receipt: graphErasureReceipt(id) },
      };
      const command = buildHeldGraphErasureCommand(
        id,
        entry.erasureEpoch,
        targets,
        malformed,
        units,
        KEY,
      );
      expect((await post(label, command)).body).toMatchObject({ status: 'invalid' });
      expect(await snapshot()).toEqual(baseline);
    }
    let authorizations = 0,
      transportCalls = 0;
    const assertCurrent = async (authorization: HeldGraphErasureAuthorization) => {
      authorizations++;
      const current = await readErasure(relay, entry.erasureId);
      expect(current.erasureEpoch).toBe(authorization.epoch);
      expect(current.erasureId).toBe(authorization.erasureId);
      expect(current.targets.map((target) => target.ref).sort()).toEqual(
        [...authorization.revisionIds].sort(),
      );
      expect(
        await readGraphErasureProof(
          originalClient,
          prior,
          entry.erasureId,
          entry.erasureEpoch,
          held.revisionIds,
        ),
      ).toEqual(authorization.original);
      expect(
        (await access.query('SELECT open, generation::text FROM access.recovery_fence WHERE id'))
          .rows,
      ).toEqual([{ open: false, generation: authorization.accessHoldGeneration }]);
      expect(await heldGraphLineageSequence(graph, authorization.cut)).toBe('0');
    };
    // A captured generation that differs from the actual closed Access fence
    // must be refused before any signed native request is sent.
    let staleGenerationCalls = 0;
    await expect(
      suppressHeldGraphContentRevisions(
        graph,
        entry.erasureId,
        entry.erasureEpoch,
        held.revisionIds,
        {
          ...held,
          accessHoldGeneration: (BigInt(generation) + 1n).toString(),
          signingKey: KEY,
          assertCurrent,
          maintenance: {
            command: (command) => {
              staleGenerationCalls++;
              return heldErasureMaintenanceClient(restored!.url, MAINTENANCE).command(command);
            },
          },
        },
      ),
    ).rejects.toThrow();
    expect(staleGenerationCalls).toBe(0);
    expect(await snapshot()).toEqual(baseline);
    // A transport-only fault: no native success response is synthesized. The
    // first request never reaches Fuseki; the second really commits upstream,
    // but its response is discarded. The caller must read the exact native proof.
    proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        transportCalls++;
        if (transportCalls === 1) {
          expect(await snapshot()).toEqual(baseline);
          return new Response('interrupted before forwarding', { status: 502 });
        }
        const body = await request.text();
        writeFileSync(join(evidence, 'sent-command.json'), body);
        expect(JSON.parse(JSON.parse(body).titleAdmission.payload)).toHaveLength(17);
        const upstream = await fetch(new URL('command', restored!.url), {
          method: 'POST',
          headers: request.headers,
          body,
        });
        const result = await upstream.json();
        responses.push({
          label: 'actual-native-commit-response-discarded',
          status: upstream.status,
          body: result,
        });
        expect(result).toMatchObject({
          status: 'committed',
          position: { dataEpoch: next.dataEpoch, sequence: '0' },
        });
        return new Response('interrupted after native commit', { status: 502 });
      },
    });
    const replay = {
      ...held,
      signingKey: KEY,
      assertCurrent,
      maintenance: heldErasureMaintenanceClient(
        `http://127.0.0.1:${proxy.port}/rezics/`,
        MAINTENANCE,
      ),
    };
    expect(
      await suppressHeldGraphContentRevisions(
        graph,
        entry.erasureId,
        entry.erasureEpoch,
        held.revisionIds,
        replay,
      ),
    ).toEqual(original);
    expect(transportCalls).toBe(2);
    expect(authorizations).toBeGreaterThanOrEqual(6);
    expect(await controls()).toEqual(beforeControl);
    expect(
      await probeHeldGraphErasureProof(
        graph,
        entry.erasureId,
        entry.erasureEpoch,
        held.revisionIds,
        held,
        true,
      ),
    ).toEqual(original);
    expect(await text(PUBLIC, 'searchBody', 'forbidden')).toEqual([]);
    expect(await text(PRIVATE, 'privateSearchBody', 'forbidden')).toEqual([]);
    expect(await text(PUBLIC, 'searchBody', 'retained')).toEqual([unit(10)]);
    expect(await text(PRIVATE, 'privateSearchBody', 'retained')).toEqual([unit(11)]);
    const after = await snapshot();
    const retainedSubjects = new Set([
      revision(ids[2]!),
      unit(3),
      unit(10),
      unit(11),
      'urn:rezics:held-http:manifest',
      'urn:rezics:held-http:model',
      ...baseline
        .filter((row) => row.g!.value === 'urn:rezics:graph:receipts')
        .map((row) => row.s!.value),
    ]);
    expect(after.filter((row) => retainedSubjects.has(row.s!.value))).toEqual(
      baseline.filter((row) => retainedSubjects.has(row.s!.value)),
    );
    expect(
      after.filter(
        (row) =>
          row.s!.value.startsWith('urn:rezics:held-http:manifest') ||
          row.s!.value.startsWith('urn:rezics:held-http:model'),
      ),
    ).toEqual(
      baseline.filter(
        (row) =>
          row.s!.value.startsWith('urn:rezics:held-http:manifest') ||
          row.s!.value.startsWith('urn:rezics:held-http:model'),
      ),
    );
    const maintenance = heldErasureMaintenanceClient(restored.url, MAINTENANCE);
    const retry = buildHeldGraphErasureCommand(
      entry.erasureId,
      entry.erasureEpoch,
      held.revisionIds,
      held,
      [],
      KEY,
    );
    expect(await maintenance.command(retry)).toMatchObject({
      status: 'committed',
      position: { dataEpoch: next.dataEpoch, sequence: '0' },
    });
    // An existing matching digest cannot bypass renewed native authorization.
    const rejectedRetry = resign(retry, (f) => {
      f[14] = '2000-01-01T00:00:00Z';
    });
    expect((await post('expired-existing-receipt-retry', rejectedRetry)).body).toMatchObject({
      status: 'invalid',
    });
    let rejectedCalls = 0;
    await expect(
      suppressHeldGraphContentRevisions(
        graph,
        entry.erasureId,
        entry.erasureEpoch,
        held.revisionIds,
        {
          ...replay,
          maintenance: {
            command: (command) => {
              rejectedCalls++;
              return maintenance.command(
                resign(command, (f) => {
                  f[14] = '2000-01-01T00:00:00Z';
                }),
              );
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(GraphErasureConflict);
    expect(rejectedCalls).toBe(1);
    expect(await snapshot()).toEqual(after);
    expect(
      await assertGraphErasure(graph, next, entry.erasureId, entry.erasureEpoch, held.revisionIds, {
        ...replay,
        maintenance,
      }),
    ).toBe(true);
    expect(
      await replayGraphErasure(
        graph,
        next,
        entry.erasureId,
        entry.erasureEpoch,
        held.revisionIds,
        true,
        { ...replay, maintenance },
      ),
    ).toBe('replayed');
    expect(await controls()).toEqual(beforeControl);
    expect(
      (await access.query('SELECT open, generation::text FROM access.recovery_fence WHERE id'))
        .rows,
    ).toEqual([{ open: false, generation }]);
    writeFileSync(
      join(evidence, 'observations.json'),
      JSON.stringify(
        {
          original,
          held,
          beforeControl,
          afterControl: await controls(),
          authorizations,
          transportCalls,
          responses,
          qualification:
            'focused real native HTTP proof; no populated campaign qualification or Main activation claim',
        },
        null,
        2,
      ),
    );
  } finally {
    await proxy?.stop(true);
    writeFileSync(join(evidence, 'responses.json'), JSON.stringify(responses, null, 2));
    restored?.remove();
    source?.remove();
    // Names also clean up a container whose readiness failed before assignment.
    spawnSync('docker', ['rm', '-f', `${name}-copy`, name], {
      env: stack.dockerEnv,
      timeout: 60_000,
    });
    spawnSync('docker', ['volume', 'rm', '-f', volume], { env: stack.dockerEnv, timeout: 60_000 });
    await access.end();
    await relay.end();
    await databases.close();
  }
}, 180_000);
