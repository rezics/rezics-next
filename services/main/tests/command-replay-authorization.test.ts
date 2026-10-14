import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript-6';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { stageQaBootstrap } from '../../../scripts/qa/bootstrap.ts';
import { admitIntegrationWorkScope, qaStartupTestTimeout, runQaAdmissionChildAsync,
  runQaStartupChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { exclusiveWorkScopeAssembler, qaStackEnvironment } from '../../../scripts/qa/stack-environment.ts';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { deactivateFixtureController, ensureFixtureScopeGate, expireFixtureAuthority,
  grantFixtureAuthority, registerFixtureIdentity, reduceFixtureGrant } from '../src/modules/access/fixture-authority.ts';
import { AccessAgentControl } from '../src/modules/access/agent-control.ts';
import { ControlDenied } from '../src/modules/access/topology-control.ts';
import { AgentProfileDenied, AgentPublicProfiles } from '../src/modules/agent/profile.ts';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import { GovernanceDenied, GLOBAL_CONTEXT } from '../src/modules/governance/store.ts';
import { createAdmittedMetadataWork } from '../src/modules/work/create-admitted.ts';
import { readTitleControl } from '../src/modules/work/title-control.ts';
import { SourceNativeWorkAdoptionStore } from '../src/modules/source/native-work-adoption.ts';

const root = resolve(import.meta.dir, '../../..');
const evidenceDirectory = join(root, '.temp/goal/replay-authorization');
let stack: MediaStack;
let legacyCluster: PostgresCluster;
let legacyPool: Pool;
let legacyController: Member;
let selfHostedRun: string | undefined;
const savedEnvironment = { ...process.env };
type Member = Awaited<ReturnType<MediaStack['member']>>;
type Loss = 'expired' | 'revoked';
interface Scenario {
  command: (fresh?: boolean, changed?: boolean) => Promise<unknown>;
  lose: (loss: Loss) => Promise<void>;
  snapshot: () => Promise<unknown>;
  advance?: () => Promise<void>;
}
interface ReplayFamily {
  family: string;
  owners: string[];
  subcases: string[];
  denied: new (...args: never[]) => Error;
  fixture: (subcase: string, loss: Loss) => Promise<Scenario>;
  losses?: Loss[];
}

beforeAll(async () => {
  mkdirSync(evidenceDirectory, { recursive: true });
  if (!process.env.FUSEKI_URL || !process.env.REZICS_QA_RUN_ID) {
    selfHostedRun = `replay-${randomUUID().slice(0, 18)}`;
    const environment = { ...qaStackEnvironment(process.env),
      REZICS_FUSEKI_ASSEMBLER: exclusiveWorkScopeAssembler };
    const startup = await runQaStartupChildAsync(root,
      ['stack:up', '--profile', 'qa', '--run-id', selfHostedRun], 180_000, environment, console.log);
    if (!startup.ok) throw new Error(`Replay owner stack startup failed: ${startup.output.slice(-4000)}`);
    const directory = join(root, '.temp/stack', `rezics-qa-${selfHostedRun}`);
    const staged = stageQaBootstrap(directory);
    const bootstrap = await runQaAdmissionChildAsync(root, 'bun', staged.args, 180_000, environment);
    if (!bootstrap.ok) throw new Error(`Replay owner bootstrap failed: ${bootstrap.output.slice(-4000)}`);
    const apps = readEnv(join(directory, 'apps.env'));
    await admitIntegrationWorkScope({ root, projectRunId: selfHostedRun, fusekiUrl: apps.FUSEKI_URL!,
      maintenanceToken: apps.FUSEKI_MAINTENANCE_TOKEN, environment });
    Object.assign(process.env, apps, { REZICS_QA_RUN_ID: selfHostedRun });
    expect(startup.activeElapsedMs + bootstrap.elapsedMs).toBeLessThan(600_000);
  }
  stack = await startMediaStack('command-replay-authorization', { profileCredits: true });
  legacyCluster = await startPostgresCluster();
  legacyPool = new Pool({ ...legacyCluster.connection, max: 4 });
  legacyController = await stack.member('legacy-controller');
  // Reproduce the supported upgrade from finite legacy mandates. Current
  // controller episodes cannot be shortened, so expiry cannot be injected
  // into a freshly installed open-ended controller.
  const files = schemaFiles(root, 'access');
  for (const file of files.filter(file => Number(file.split('_')[0]) < 54)) {
    await legacyPool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
  const client = await legacyPool.connect();
  try {
    await client.query('BEGIN');
    await registerFixtureIdentity(client, { principalId: legacyController.principalId,
      actor: legacyController.actor, ...legacyController.principal });
    await grantFixtureAuthority(client, { scope: 'work:create:root', requireDispatch: true,
      representations: [{ principalId: legacyController.principalId, actor: legacyController.actor,
        action: 'agent.control', lifetime: '8 hours' }],
      grant: { actor: legacyController.actor, action: 'agent.control', lifetime: '8 hours' } });
    await client.query('COMMIT');
  } finally { client.release(); }
  for (const file of files.filter(file => Number(file.split('_')[0]) >= 54 && Number(file.split('_')[0]) < 873)) {
    await legacyPool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
}, qaStartupTestTimeout(600_000));
afterAll(async () => {
  await legacyPool?.end(); legacyCluster?.remove(); await stack?.stop();
  if (selfHostedRun) {
    const stopped = await runQaAdmissionChildAsync(root, 'task',
      ['stack:reset', '--', '--profile', 'qa', '--run-id', selfHostedRun], 60_000);
    for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name];
    Object.assign(process.env, savedEnvironment);
    if (!stopped.ok) throw new Error('Replay owner stack cleanup failed');
  }
});

const request = (member: Member) => new Request('http://main.local/', {
  headers: { authorization: `Bearer ${member.token}` },
});
const principal = (member: Member) => stack.composition.dependencies.account.verify(request(member), []);
const head = async (agent: string) => (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
  SELECT ?head WHERE { GRAPH <urn:rezics:graph:current> { <${agent}> rv:head ?head } } LIMIT 2`))
  .results!.bindings![0]!.head!.value;
async function graphSnapshot(resource: string, receipt: string) {
  return (await stack.fuseki.query(`SELECT ?g ?s ?p ?o WHERE {
    VALUES ?g { <urn:rezics:graph:current> <urn:rezics:graph:receipts> }
    VALUES ?s { <${resource}> <${receipt}> } GRAPH ?g { ?s ?p ?o }
  } ORDER BY ?g ?s ?p ?o LIMIT 256`)).results?.bindings;
}
async function loseGrant(member: Member, grant: string, loss: Loss) {
  if (loss === 'expired') await expireFixtureAuthority(stack.accessPool, member.actor);
  else await reduceFixtureGrant(stack.accessPool, grant, { active: false });
}
async function proposal(member: Member, externalId: string, title: string, revision: number) {
  const deps = stack.composition.dependencies;
  const raw = Buffer.from(JSON.stringify({ key: `/works/${externalId}`, type: { key: '/type/work' },
    title, revision }));
  const observed = await deps.sourceIntake!.submit(member.principalId, randomUUID(), {
    provider: 'open-library', namespace: 'work', externalId, sourceRevision: String(revision),
    mediaType: 'application/json', retention: 'retained', rawBytesBase64: raw.toString('base64'),
    coverage: { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] },
    rightsEvidence: { basis: 'unknown', note: '' },
  }, { profile: 'open-library-work-acquisition-v1', url: `https://openlibrary.org/works/${externalId}.json`,
    status: 200, etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
  const conversion = await deps.sourceConversions!.convert(member.principalId,
    observed.observation.observation.split('/').at(-1)!);
  const conversionId = conversion!.conversion.conversion.split('/').at(-1)!;
  await deps.sourceGraph!.project(member.principalId, conversionId);
  return (await deps.sourceProposals!.propose(member.principalId, conversionId))!.proposal;
}
const sourceSnapshot = async (work: string, receipt: string, actor: string) => ({
  graph: await graphSnapshot(work, receipt),
  bindings: (await stack.contentPool.query(`SELECT to_jsonb(b) AS row FROM source.native_work_binding b
    JOIN source.native_work_adoption_intent i ON i.id = b.intent_id WHERE i.acting_subject = $1 ORDER BY b.id`,
  [actor])).rows,
  applications: (await stack.contentPool.query(`SELECT to_jsonb(a) AS row
    FROM source.native_work_title_application a WHERE work = $1 ORDER BY id`, [work])).rows,
});

// Each row names real owners reached by public callers. Saved witnesses remain
// part of the original command; losing live authority must not disclose them.
const replayFamilies: ReplayFamily[] = [
  { family: 'shared Access admissions', owners: ['modules/work/create-admitted.ts#createAdmittedMetadataWork'],
    subcases: ['represented Work creation'], denied: AdmissionDenied,
    fixture: async () => {
      const member = await stack.member(randomUUID());
      const grant = await member.grant('work:create:root', 'work.create');
      const input = { actingSubject: member.actor, title: `Replay ${randomUUID()}`,
        language: 'en', idempotencyKey: randomUUID() };
      let saved: Awaited<ReturnType<typeof createAdmittedMetadataWork>>;
      return { command: async (fresh, changed) => {
        const result = await createAdmittedMetadataWork(stack.env, stack.composition.dependencies.account,
          stack.access, request(member), { ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
            ...(changed ? { title: 'Different binding' } : {}) });
        saved ??= result;
        return result;
      }, lose: loss => loseGrant(member, grant, loss),
      snapshot: () => graphSnapshot(saved.work, saved.receipt) };
    } },
  { family: 'Agent profile changes', owners: ['modules/agent/profile.ts#AgentPublicProfiles.change'],
    subcases: ['public profile v1'], denied: AgentProfileDenied,
    fixture: async (_subcase, loss) => {
      const legacy = loss === 'expired';
      const member = legacy ? legacyController : await stack.member(randomUUID());
      const pool = legacy ? legacyPool : stack.accessPool;
      if (!legacy) {
        const spare = await stack.member('spare-controller');
        await grantFixtureAuthority(pool, { scope: 'work:create:root', requireDispatch: true,
          representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
            { principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
          grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
      }
      const control = (await pool.query<{ id: string }>(`SELECT id FROM access.representation
        WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`,
      [member.principalId, member.actor])).rows[0]!.id;
      const input = { agent: member.actor, expectedHead: await head(member.actor), displayName: 'Saved name',
        avatarSelection: null, bio: null, idempotencyKey: randomUUID() };
      const owner = legacy ? new AgentPublicProfiles(pool, stack.env, stack.media.store)
        : stack.composition.dependencies.agentProfiles!;
      let saved: Awaited<ReturnType<typeof owner.change>>;
      return { command: async (fresh, changed) => {
        const result = await owner.change(await principal(member), { ...input,
          ...(fresh ? { idempotencyKey: randomUUID(), expectedHead: saved.revision } : {}),
          ...(changed ? { displayName: 'Different binding' } : {}) });
        saved ??= result;
        return result;
      }, advance: async () => { await owner.change(await principal(member), { ...input,
        expectedHead: saved.revision, displayName: 'Advanced name', idempotencyKey: randomUUID() }); },
      lose: async () => {
        if (legacy) {
          await expireFixtureAuthority(pool, member.actor);
          for (const file of schemaFiles(root, 'access').filter(file => Number(file.split('_')[0]) >= 873)) {
            await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
          }
        } else await deactivateFixtureController(pool, control);
      }, snapshot: () => graphSnapshot(member.actor, saved.receipt) };
    } },
  { family: 'report and rights complaint submission', owners: ['modules/governance/store.ts#GovernanceStore.submitReport'],
    subcases: ['content_report', 'rights_complaint'], denied: GovernanceDenied,
    fixture: async (subcase, loss) => {
      const member = await stack.member(randomUUID());
      let revokedController: string | undefined;
      if (loss === 'revoked') {
        await expireFixtureAuthority(stack.accessPool, member.actor);
        const spare = await stack.member('report-spare-controller');
        const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
          representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
            { principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
          grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
        revokedController = authority.representationIds[0];
      }
      // submitReport's existing represented() accepts any current mandate.
      const reported = await proposal(member, `OL${Math.floor(Math.random() * 900000000) + 100000000}W`, 'Reported source', 1);
      await ensureFixtureScopeGate(stack.accessPool, 'governance:platform', { open: true });
      const target = { owner: 'source' as const, resource: reported.record, component: 'record' as const };
      const input = { kind: subcase as 'content_report' | 'rights_complaint', actingSubject: member.actor,
        authority: { kind: 'platform' as const, scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
        target, disclosure: 'private' as const, reasonCode: 'spam', statement: 'Retain this exact title.',
        evidence: [{ ...target, revision: reported.observation, locator: null }], idempotencyKey: randomUUID(),
        ...(subcase === 'rights_complaint' ? { complaint: { process: 'ordinary_dispute' as const,
          claimantKind: 'rights_holder' as const, claimantName: 'Claimant', claimantContact: null,
          claimedWork: 'Original title', claimedRight: 'copyright' as const,
          noticeDigest: 'a'.repeat(64), noticeReceivedAt: new Date().toISOString() } } : {}) };
      const owner = stack.composition.dependencies.governance!.store;
      return { command: async (fresh, changed) => owner.submitReport(await principal(member), { ...input,
        ...(fresh ? { idempotencyKey: randomUUID() } : {}), ...(changed ? { statement: 'Changed notice.' } : {}) }),
      lose: async () => {
        if (revokedController) await deactivateFixtureController(stack.accessPool, revokedController);
        else await expireFixtureAuthority(stack.accessPool, member.actor);
      },
      snapshot: async () => (await stack.accessPool.query(`SELECT to_jsonb(r) AS report,
        (SELECT jsonb_agg(to_jsonb(e) ORDER BY ordinal) FROM access.governance_evidence e
          WHERE report_id = r.id) AS evidence FROM access.governance_report r
        WHERE principal_id = $1 ORDER BY id`, [member.principalId])).rows };
    } },
  { family: 'native source Work adoption', owners: ['modules/source/native-work-adoption.ts#SourceNativeWorkAdoptionStore.adopt'],
    subcases: ['represented-agent'], denied: AdmissionDenied,
    fixture: async () => {
      const member = await stack.member(randomUUID());
      const grant = await member.grant('work:create:root', 'work.create');
      const externalId = `OL${Math.floor(Math.random() * 900000000) + 100000000}W`;
      const original = await proposal(member, externalId, 'Source original', 1);
      const freshProposal = await proposal(member, externalId.replace('W', '1W'), 'Source original', 1);
      const owner = new SourceNativeWorkAdoptionStore(stack.contentPool, stack.composition.dependencies.sourceProposals!,
        stack.env, stack.composition.dependencies.account, stack.access);
      let saved: NonNullable<Awaited<ReturnType<typeof owner.adopt>>>;
      return { command: async (fresh, changed) => {
        const result = await owner.adopt(member.principalId, request(member),
          (fresh ? freshProposal : original).proposal.split('/').at(-1)!,
          { actingSubject: member.actor, authorityPath: 'represented-agent',
            confirmedTitle: changed ? 'Different title' : 'Source original' });
        saved ??= result!;
        return result;
      }, lose: loss => loseGrant(member, grant, loss),
      snapshot: () => sourceSnapshot(saved.adoption.work, saved.adoption.receipt, member.actor) };
    } },
  { family: 'source title application', owners: ['modules/source/native-work-adoption.ts#SourceNativeWorkAdoptionStore.applyTitle'],
    subcases: ['represented-agent'], denied: AdmissionDenied,
    fixture: async () => {
      const member = await stack.member(randomUUID());
      await member.grant('work:create:root', 'work.create');
      const externalId = `OL${Math.floor(Math.random() * 900000000) + 100000000}W`;
      const original = await proposal(member, externalId, 'Source original', 1);
      const owner = new SourceNativeWorkAdoptionStore(stack.contentPool, stack.composition.dependencies.sourceProposals!,
        stack.env, stack.composition.dependencies.account, stack.access);
      const adopted = (await owner.adopt(member.principalId, request(member), original.proposal.split('/').at(-1)!,
        { actingSubject: member.actor, authorityPath: 'represented-agent', confirmedTitle: 'Source original' }))!.adoption;
      await member.grant(`work:edit:${adopted.work}`, 'work.edit');
      const grant = await member.grant(`work:title:apply:${adopted.work}`, 'work.title.apply');
      const candidate = await proposal(member, externalId, 'Source next', 2);
      const freshProposal = await proposal(member, externalId, 'Source latest', 3);
      const input = { expectedHead: adopted.workRevision, actingSubject: member.actor, confirmedTitle: 'Source next',
        titleControl: (await readTitleControl(stack.env, adopted.work)).basis };
      let saved: NonNullable<Awaited<ReturnType<typeof owner.applyTitle>>>;
      return { command: async (fresh, changed) => {
        const result = await owner.applyTitle(member.principalId, request(member), adopted.work,
          (fresh ? freshProposal : candidate).proposal.split('/').at(-1)!, { ...input,
            ...(fresh ? { expectedHead: saved.application.workRevision, confirmedTitle: 'Source latest',
              titleControl: (await readTitleControl(stack.env, adopted.work)).basis } : {}),
            ...(changed ? { confirmedTitle: 'Different binding' } : {}) });
        saved ??= result!;
        return result;
      }, lose: loss => loseGrant(member, grant, loss),
      snapshot: () => sourceSnapshot(adopted.work, saved.application.receipt, member.actor) };
    } },
  { family: 'Agent control policy (authorized before shared receipted helper)',
    owners: ['modules/access/agent-control.ts#AccessAgentControl.configure'],
    subcases: ['controller policy'], losses: ['revoked'], denied: ControlDenied,
    fixture: async () => {
      const member = await stack.member(randomUUID()), recovery = await stack.member(randomUUID());
      const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
          { principalId: recovery.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
      await ensureFixtureScopeGate(stack.accessPool, 'access:representation-topology', { open: true });
      const owner = new AccessAgentControl(stack.accessPool);
      const receipt = { idempotencyKey: randomUUID(), requestDigest: 'c'.repeat(64) };
      const input = { subjectId: member.actor, recoverySubject: recovery.actor, recoveryApprovals: 1,
        recoveryDelaySeconds: 0, minControllers: 1, maxControllers: 8 };
      return { command: async fresh => owner.configure(await principal(member),
        fresh ? { ...receipt, idempotencyKey: randomUUID() } : receipt, input),
      lose: async () => { await deactivateFixtureController(stack.accessPool, authority.representationIds[0]!); },
      snapshot: async () => (await stack.accessPool.query(`SELECT to_jsonb(c) AS row
        FROM access.agent_control c WHERE subject_id = $1`, [member.actor])).rows };
    } },
];

function originalResult(result: unknown): unknown {
  const { replayed: _replayed, ...rest } = result as Record<string, unknown>;
  return rest;
}
async function refusal(command: () => Promise<unknown>) {
  try { return { disclosed: await command() }; }
  catch (error) { return { error }; }
}
for (const row of replayFamilies) for (const subcase of row.subcases) for (const loss of row.losses ?? ['expired', 'revoked'] as const) {
  test(`${row.family} / ${subcase} / ${loss}: exact replay requires current authority`, async () => {
    const fixture = await row.fixture(subcase, loss);
    const original = await fixture.command();
    expect(original).toBeTruthy();
    expect(originalResult(await fixture.command())).toEqual(originalResult(original));
    if (row.family !== 'Agent control policy (authorized before shared receipted helper)') {
      expect((await refusal(() => fixture.command(false, true))).error).toBeInstanceOf(Error);
    }
    await fixture.advance?.();
    expect(originalResult(await fixture.command())).toEqual(originalResult(original));
    const before = await fixture.snapshot();
    await fixture.lose(loss);
    const replay = await refusal(() => fixture.command());
    const fresh = await refusal(() => fixture.command(true));
    const after = await fixture.snapshot();
    writeFileSync(join(evidenceDirectory, `${row.family.replaceAll(/\W+/g, '-')}-${subcase}-${loss}.json`),
      JSON.stringify({ family: row.family, subcase, loss, original, replay, fresh, before, after },
        (_key, value: unknown) => value instanceof Error ? { name: value.name, message: value.message } : value, 2));
    expect(after).toEqual(before);
    expect(fresh.error).toBeInstanceOf(row.denied);
    expect(replay.error, JSON.stringify(replay)).toBeInstanceOf(row.denied);
    expect((replay.error as Error).message).toBe((fresh.error as Error).message);
  }, 60_000);
}

// Resolve symbols from public HTTP handlers through actual owner methods and
// helper calls. New saved-result paths must acquire a runtime table row.
test('every discovered public saved-result command has a replay-authorization row', () => {
  const files = [...new Bun.Glob('services/main/src/**/*.ts').scanSync({ cwd: root, absolute: true })];
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const functionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)
      || ts.isFunctionExpression(node);
  const label = (node: ts.Node) => {
    const name = 'name' in node && node.name && ts.isIdentifier(node.name as ts.Node)
      ? (node.name as ts.Identifier).text : '<handler>';
    const owner = ts.isClassDeclaration(node.parent) ? `${node.parent.name?.text}.` : '';
    return `${relative(join(root, 'services/main/src'), node.getSourceFile().fileName)}#${owner}${name}`;
  };
  const descend = (node: ts.Node, visit: (node: ts.Node) => void) => {
    visit(node);
    ts.forEachChild(node, child => descend(child, visit));
  };
  const edgeCache = new Map<ts.FunctionLikeDeclaration, Set<ts.FunctionLikeDeclaration>>();
  const edges = (node: ts.FunctionLikeDeclaration) => {
    const cached = edgeCache.get(node);
    if (cached) return cached;
    const targets = new Set<ts.FunctionLikeDeclaration>();
    if (node.body) descend(node.body, child => {
      if (!ts.isCallExpression(child)) return;
      const declaration = checker.getResolvedSignature(child)?.declaration;
      if (declaration && functionLike(declaration) && declaration.body
        && declaration.getSourceFile().fileName.startsWith(join(root, 'services/main/src/'))) targets.add(declaration);
      let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(child.expression)
        ? child.expression.name : child.expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const declared of symbol?.declarations ?? []) {
        const candidate = ts.isVariableDeclaration(declared) ? declared.initializer : declared;
        if (candidate && functionLike(candidate) && candidate.body) targets.add(candidate);
      }
    });
    edgeCache.set(node, targets);
    return targets;
  };
  const savedCache = new Map<ts.FunctionLikeDeclaration, boolean>();
  const savedResult = (node: ts.FunctionLikeDeclaration) => {
    const cached = savedCache.get(node);
    if (cached !== undefined) return cached;
    let saved = false;
    if (node.body) descend(node.body, child => {
      if (ts.isPropertyAssignment(child) && child.name.getText() === 'replayed'
        && child.initializer.kind === ts.SyntaxKind.TrueKeyword) saved = true;
      if (ts.isCallExpression(child)) {
        const declaration = checker.getResolvedSignature(child)?.declaration;
        child.arguments.forEach((arg, index) => {
          if (arg.kind === ts.SyntaxKind.TrueKeyword
            && declaration?.parameters[index]?.name.getText() === 'replayed') saved = true;
        });
      }
    });
    savedCache.set(node, saved);
    return saved;
  };
  const inventory: { operation: string; caller: string; paths: string[][] }[] = [];
  for (const source of program.getSourceFiles().filter(file => file.fileName.startsWith(join(root, 'services/main/src/routes/')))) {
    // Contract declarations supply exposure independently of route traversal.
    const contracts = new Map<string, string>();
    const normalize = (path: string) => path.replace(/:[^/]+|\{[^}]+\}/g, '{}');
    const inspect = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith('/v1/')
        && ts.isObjectLiteralExpression(node.initializer)) {
        for (const method of node.initializer.properties) if (ts.isPropertyAssignment(method)
          && ts.isObjectLiteralExpression(method.initializer)) {
          const exposure = method.initializer.properties.find(prop => ts.isPropertyAssignment(prop)
            && prop.name.getText() === 'exposure');
          if (exposure && ts.isPropertyAssignment(exposure) && ts.isStringLiteral(exposure.initializer)) {
            contracts.set(`${method.name.getText().toUpperCase()} ${normalize(node.name.text)}`, exposure.initializer.text);
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    const routes = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['post', 'put', 'patch', 'delete'].includes(node.expression.name.text)
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const operation = `${node.expression.name.text.toUpperCase()} ${normalize(node.arguments[0].text)}`;
        if (contracts.get(operation) === 'public') {
          const handler = node.arguments.find(arg => functionLike(arg));
          if (handler && functionLike(handler)) {
            const paths: string[][] = [];
            const visited = new Set<ts.Node>();
            const walk = (current: ts.FunctionLikeDeclaration, path: string[]) => {
              if (visited.has(current)) return;
              visited.add(current);
              const next = [...path, label(current)];
              if (savedResult(current)) paths.push(next);
              for (const target of edges(current)) walk(target, next);
            };
            walk(handler, []);
            if (paths.length) inventory.push({ operation, caller: relative(root, source.fileName), paths });
          }
        }
      }
      ts.forEachChild(node, routes);
    };
    routes(source);
  }
  writeFileSync(join(evidenceDirectory, 'public-command-inventory.json'), JSON.stringify(inventory, null, 2));
  expect(inventory.some(item => item.paths.some(path => path.includes('modules/agent/profile.ts#AgentPublicProfiles.change')))).toBe(true);
  const owners = new Set(replayFamilies.flatMap(row => row.owners));
  const missing = inventory.filter(item => item.paths.some(path => !path.some(owner => owners.has(owner))));
  expect(missing.map(item => `${item.operation}: ${item.paths.map(path => path.join(' -> ')).join('; ')}`)).toEqual([]);
}, 120_000);
