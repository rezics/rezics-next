import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import type { ContentModeration } from '../../content/src/moderation.ts';
import type { CommandEnvelope } from '../src/infrastructure/fuseki.ts';
import { graphNoticeParticipants, ownerModerationEffects, restrictionOwners } from '../src/modules/governance/effects.ts';
import { ownerTargetHeads } from '../src/modules/governance/evidence.ts';
import { prepareDecisionNotices, unrecordedReasons } from '../src/modules/governance/notices.ts';
import { GovernanceConflict, GovernanceStale, GovernanceUnavailable,
  type DecisionTargetInput } from '../src/modules/governance/store.ts';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { waitForRealmDirectory } from '../../../tests/qa/integration/support/realm-directory.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { resolveRealmProfile } from '../src/modules/space/policy.ts';
import { SafetyDecisionMail, type SafetyNoticeMail } from '../src/modules/governance/notices-mail.ts';
import { DECIDE_ACTION, GLOBAL_CONTEXT, type DecisionInput } from '../src/modules/governance/store.ts';
import { GRAPHS, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000101';
const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000000102';
const owner = 'https://rezics.com/id/00000000-0000-4000-8000-000000000103';
const head = 'https://rezics.com/id/00000000-0000-4000-8000-000000000104';
const laterHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000105';
const operation = '00000000-0000-4000-8000-000000000106';
const profile = (version: number) => `https://rezics.com/definition/space-realm-v${version}`;
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
const target = (expectedHead = head): DecisionTargetInput => ({
  owner: 'graph', resource: realm, component: 'record', locator: null,
  scopeKind: 'component', revision: null, expectedHead, effect: 'disclosure',
});

/** The owner simulator retains committed receipts independently of response delivery.
 * Guard assertions below ensure races are rejected by the emitted atomic command. */
function graph(version = 3, declared = true) {
  const state = {
    kind: `${RV}Realm`, head: head as string | null, active: true, reciprocal: true,
    spaces: [space], extraHeads: [] as string[], extraKinds: [] as string[],
    realmProfile: declared ? profile(version) : undefined as string | undefined,
    spaceProfile: declared ? profile(version) : undefined as string | undefined,
    restoreHold: false,
  };
  const reads: { sql: string; maximum?: number }[] = [];
  const commands: CommandEnvelope[] = [];
  const receipts = new Map<string, { digest: string; head: string }>();
  let beforeCommand: (() => void) | undefined;
  let loseResponse = false;
  let failBeforeCommit = false;
  let commandStatus: 'invalid' | 'unknown-profile' | undefined;
  const env = { lineage: { dataEpoch: 'realm-target-epoch', routingEpoch: 'realm-target-routing' },
    objectDirectory: '', fuseki: {
      query: async (sql: string, maximum?: number) => {
        reads.push({ sql, maximum });
        if (sql.includes('SELECT ?digest ?target ?head')) {
          const receipt = [...receipts].find(([id]) => sql.includes(`<${id}>`))?.[1];
          return { results: { bindings: receipt ? [{ digest: literal(receipt.digest),
            target: uri(realm), head: uri(receipt.head) }] : [] } };
        }
        if (sql.includes('SELECT DISTINCT ?author')) {
          const supportsRealmOwner = sql.includes('a rv:Realm .');
          const after = sql.match(/FILTER\(STR\(\?author\) > "([^"]+)"\)/)?.[1];
          return { results: { bindings: supportsRealmOwner && state.reciprocal
            && (!after || owner > after) ? [{ author: uri(owner) }] : [] } };
        }
        if (sql.includes('SELECT ?space ?spaceProfile ?realmProfile')) {
          return { results: { bindings: state.reciprocal ? state.spaces.map((value) => ({
            space: uri(value), ...(state.realmProfile ? { realmProfile: uri(state.realmProfile) } : {}),
            ...(state.spaceProfile ? { spaceProfile: uri(state.spaceProfile) } : {}),
          })) : [] } };
        }
        if (sql.includes('SELECT DISTINCT ?kind ?head')) {
          return { results: { bindings: [state.kind, ...state.extraKinds].flatMap((kind) =>
            [state.head, ...state.extraHeads].map((value) => ({ kind: uri(kind),
              ...(value ? { head: uri(value) } : {}) }))) } };
        }
        if (sql.includes('SELECT ?head')) return { results: { bindings: [state.head, ...state.extraHeads]
          .filter((value): value is string => !!value).map((value) => ({ head: uri(value) })) } };
        throw new Error(`Unexpected owner query: ${sql}`);
      },
      commandHealth: async () => ({ profiles: Object.fromEntries(Object.entries(profileRegistry)
        .map(([id, definition]) => [id, definition.sha256])) }),
      commandWithReceipt: async (command: CommandEnvelope) => {
        commands.push(command);
        beforeCommand?.();
        if (failBeforeCommit) throw new Error('Graph command unavailable before commit');
        if (commandStatus) return { status: commandStatus };
        if (state.kind !== `${RV}Realm`) return { status: 'invalid' };
        const guard = command.update.slice(command.update.lastIndexOf('WHERE'));
        expect(guard).toContain('rv:realmState rv:Active');
        expect(guard).toContain(`rv:realmCapability <${realm}>`);
        expect(guard).toContain('rv:space ?otherSpace');
        expect(guard).toContain('rv:head ?otherHead');
        expect(guard).toContain('rv:restoreHold true');
        expect(guard).toContain('rv:definitionProfile');
        if (!state.active || !state.reciprocal || state.spaces.length !== 1 || state.restoreHold
          || !state.head || !guard.includes(`<${state.head}>`)
          || state.extraHeads.length
          || (declared ? state.realmProfile !== profile(version) || state.spaceProfile !== profile(version)
            : !!state.realmProfile || !!state.spaceProfile)) return { status: 'guard-unmatched' };
        receipts.set(command.receipt, { digest: command.digest, head: state.head });
        if (loseResponse) throw new Error('Graph response lost after commit');
        return { status: 'committed', position: { dataEpoch: 'realm-target-epoch', sequence: '1' } };
      },
    } } as unknown as WorkActivationEnvironment;
  return { state, reads, commands, receipts, env,
    effects: ownerModerationEffects({} as ContentModeration, env),
    mutateBeforeCommand(fn: () => void) { beforeCommand = fn; },
    loseResponse() { loseResponse = true; },
    failBeforeCommit() { failBeforeCommit = true; },
    rejectCommand(status: 'invalid' | 'unknown-profile') { commandStatus = status; },
  };
}

for (const [version, declared] of [[1, false], [1, true], [2, true], [3, true]] as const) {
  test(`Realm v${version} ${declared ? 'declared' : 'legacy'} owner validates both reciprocal current shapes`, async () => {
    const f = graph(version, declared);
    expect(await ownerTargetHeads({ graph: f.env }).realmBasis!(target())).toEqual({
      realm, space, head, profile: profile(version), profileId: `space-realm-v${version}`, legacy: !declared,
    });
    const result = await f.effects.apply(operation, 1, target());
    expect(result).toEqual({ receipt: f.commands[0]!.receipt });
    const command = f.commands[0]!;
    expect(command.validations).toEqual([
      expect.objectContaining({ profile: `space-realm-v${version}`, shape: `${profile(version)}/space-shape`,
        focus: [space], graphs: [GRAPHS.current] }),
      expect.objectContaining({ profile: `space-realm-v${version}`, shape: `${profile(version)}/realm-shape`,
        focus: [realm], graphs: [GRAPHS.current] }),
    ]);
    expect(command.update).toContain(`rv:work <${realm}>`);
    const guard = command.update.slice(command.update.lastIndexOf('WHERE'));
    expect(guard).toContain('rv:realmState rv:Active');
    expect(guard).toContain(`rv:space <${space}>`);
    expect(guard).toContain(`rv:realmCapability <${realm}>`);
    expect(guard).toContain(`rv:head <${head}>`);
    expect(guard).toContain('rv:restoreHold true');
    expect(guard).toContain('rv:head ?otherHead');
    expect(guard).toContain('rv:space ?otherSpace');
    expect(guard).toContain('rv:definitionProfile');
    if (declared) expect(guard).toContain(`<${profile(version)}>`);
    else {
      expect(guard.match(/FILTER NOT EXISTS/g)!.length).toBeGreaterThanOrEqual(4);
      expect(guard).not.toContain('UNION');
    }
    expect(f.receipts.size).toBe(1);
  });
}

test('Realm current head is independent of its policy and public profile heads for restrict and release', async () => {
  const f = graph();
  expect(await ownerTargetHeads({ graph: f.env }).current(target())).toBe(head);
  for (const unrelatedHead of ['urn:rezics:realm-policy:current', 'urn:rezics:public-profile:current']) {
    await expect(f.effects.apply(operation, 1, target(unrelatedHead))).rejects.toBeInstanceOf(GovernanceStale);
  }
  expect(f.receipts.size).toBe(0);
  await f.effects.apply(operation, 1, target(), { outcome: 'restrict' });
  f.state.head = laterHead;
  await f.effects.apply(operation, 2, target(laterHead), { outcome: 'restore' });
  expect(f.receipts.size).toBe(2);
  expect(f.commands.at(-1)!.update).toContain(`rv:head <${laterHead}>`);
  expect(f.reads.filter(({ sql }) => sql.includes('SELECT ?head'))
    .every(({ sql }) => !sql.includes('realmPolicyHead') && !sql.includes('publicProfileHead'))).toBe(true);
});

for (const component of ['title', 'name'] as const) {
  test(`a narrower Realm ${component} restriction still validates its Realm and Space shapes`, async () => {
    const f = graph();
    await f.effects.apply(operation, 1, { ...target(), component });
    expect(f.commands[0]!.validations.map(({ shape }) => shape)).toEqual([
      `${profile(3)}/space-shape`, `${profile(3)}/realm-shape`,
    ]);
    expect(f.receipts.size).toBe(1);
  });
}

for (const component of ['body', 'structure'] as const) {
  test(`Realm ${component} does not masquerade as a Work component`, async () => {
    const f = graph();
    await expect(f.effects.apply(operation, 1, { ...target(), component }))
      .rejects.toBeInstanceOf(GovernanceStale);
    expect(f.commands).toHaveLength(0);
    expect(f.receipts.size).toBe(0);
  });
}

for (const [effect, effectOwner] of Object.entries(restrictionOwners)) {
  if (effectOwner !== 'access') continue;
  for (const component of ['body', 'structure'] as const) {
    test(`Realm ${component} cannot receive an Access-owned ${effect} effect receipt`, async () => {
      const f = graph();
      await expect(f.effects.apply(operation, 1, { ...target(), component,
        effect: effect as DecisionTargetInput['effect'] })).rejects.toBeInstanceOf(GovernanceStale);
      expect(f.commands).toHaveLength(0);
      expect(f.receipts.size).toBe(0);
    });
  }
}

for (const [name, mutate] of [
  ['mismatched profiles', (f: ReturnType<typeof graph>) => { f.state.spaceProfile = profile(2); }],
  ['missing Realm declared profile', (f: ReturnType<typeof graph>) => { f.state.realmProfile = undefined; }],
  ['missing Space declared profile', (f: ReturnType<typeof graph>) => { f.state.spaceProfile = undefined; }],
  ['duplicate Space', (f: ReturnType<typeof graph>) => { f.state.spaces.push(`${space}-duplicate`); }],
  ['nonreciprocal Space', (f: ReturnType<typeof graph>) => { f.state.reciprocal = false; }],
  ['missing head', (f: ReturnType<typeof graph>) => { f.state.head = null; }],
  ['duplicate head', (f: ReturnType<typeof graph>) => { f.state.extraHeads.push(laterHead); }],
  ['ambiguous kind', (f: ReturnType<typeof graph>) => { f.state.extraKinds.push(`${RV}Agent`); }],
] as const) {
  test(`corrupt Realm ${name} fails closed before owner command`, async () => {
    const f = graph();
    mutate(f);
    await expect(f.effects.apply(operation, 1, target())).rejects.toBeInstanceOf(GovernanceUnavailable);
    expect(f.commands).toHaveLength(0);
    expect(f.receipts.size).toBe(0);
  });
}

for (const kind of ['https://schema.org/CreativeWork', `${RV}Agent`, `${RV}Zone`]) {
  test(`another established graph kind ${kind} cannot pass Realm owner shapes`, async () => {
    const f = graph();
    f.state.kind = kind;
    expect(await ownerTargetHeads({ graph: f.env }).realmBasis!(target())).toBeNull();
    await expect(f.effects.apply(operation, 1, target())).rejects.toBeInstanceOf(GovernanceUnavailable);
    expect(f.receipts.size).toBe(0);
  });
}

for (const [name, mutate] of [
  ['head advance', (f: ReturnType<typeof graph>) => { f.state.head = laterHead; }],
  ['retirement', (f: ReturnType<typeof graph>) => { f.state.active = false; }],
  ['Space re-pairing', (f: ReturnType<typeof graph>) => { f.state.reciprocal = false; }],
  ['profile replacement', (f: ReturnType<typeof graph>) => { f.state.spaceProfile = profile(2); }],
  ['restore hold', (f: ReturnType<typeof graph>) => { f.state.restoreHold = true; }],
] as const) {
  test(`Realm ${name} between preflight and command leaves no receipt`, async () => {
    const f = graph();
    expect(await ownerTargetHeads({ graph: f.env }).current(target())).toBe(head);
    f.mutateBeforeCommand(() => mutate(f));
    await expect(f.effects.apply(operation, 1, target())).rejects.toBeInstanceOf(GovernanceStale);
    expect(f.receipts.size).toBe(0);
  });
}

for (const both of [false, true]) {
  test(`legacy Realm ${both ? 'both' : 'one'} profile declaration appearing before owner command is stale`, async () => {
    const f = graph(1, false);
    f.mutateBeforeCommand(() => {
      f.state.realmProfile = profile(1);
      if (both) f.state.spaceProfile = profile(1);
    });
    await expect(f.effects.apply(operation, 1, target())).rejects.toBeInstanceOf(GovernanceStale);
    expect(f.receipts.size).toBe(0);
  });
}

for (const status of ['invalid', 'unknown-profile'] as const) {
  test(`Realm ${status} validation cannot produce a successful owner receipt`, async () => {
    const f = graph();
    f.rejectCommand(status);
    await expect(f.effects.apply(operation, 1, target())).rejects.toBeInstanceOf(GovernanceUnavailable);
    expect(f.receipts.size).toBe(0);
  });
}

test('lost Realm owner acknowledgement resolves the saved receipt after the Realm head advances', async () => {
  const f = graph();
  f.loseResponse();
  const first = await f.effects.apply(operation, 1, target());
  f.state.head = laterHead;
  expect(await f.effects.apply(operation, 1, target())).toEqual(first);
  expect(f.commands).toHaveLength(1);
  expect(f.receipts.size).toBe(1);
  await expect(f.effects.apply(operation, 1, { ...target(), effect: 'publication' }))
    .rejects.toBeInstanceOf(GovernanceConflict);
  expect(f.commands).toHaveLength(1);
});

test('an unobserved Realm owner command remains unavailable without a receipt', async () => {
  const f = graph();
  f.failBeforeCommit();
  await expect(f.effects.apply(operation, 1, target())).rejects.toBeInstanceOf(GovernanceUnavailable);
  expect(f.receipts.size).toBe(0);
});

test('unavailable Realm classification cannot fall through to a Work command', async () => {
  const f = graph();
  f.env.fuseki.query = async () => { throw new Error('Owner graph unavailable'); };
  await expect(ownerTargetHeads({ graph: f.env }).realmBasis!(target()))
    .rejects.toBeInstanceOf(GovernanceUnavailable);
  await expect(f.effects.apply(operation, 1, target())).rejects.toThrow('Owner graph unavailable');
  expect(f.commands).toHaveLength(0);
});

test('Realm profile and type discovery remain within the bounded owner read budget', async () => {
  const f = graph();
  await ownerTargetHeads({ graph: f.env }).realmBasis!(target());
  expect(f.reads).toHaveLength(2);
  expect(f.reads.every(({ sql, maximum }) => sql.includes('LIMIT 2') && maximum === 2048)).toBe(true);
});

test('Realm Space owner notice discovery resumes over fifty controllers without reminting credentials', async () => {
  const f = graph();
  const participants = graphNoticeParticipants(f.env);
  expect(await participants.participants!(target(), null, 1)).toEqual([owner]);
  expect(await participants.participants!(target(), owner, 1)).toEqual([]);
  const decision = operation;
  const controllers = Array.from({ length: 53 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const notices = new Set<string>();
  const lookups: unknown[][] = [];
  let credentials = 0;
  const job = { ordinal: 1, target: target(), participant: owner, phase: 'graph',
    after_subject: null as string | null, subject: null as string | null,
    after_principal: null as string | null };
  const client = { query: async (sql: string, args: unknown[] = []) => {
    if (sql.includes('SELECT ordinal,target')) return { rows: job.phase === 'done' ? [] : [{ ...job }] };
    if (sql.includes('SELECT agent FROM access.work_maintainer')) return { rows: [] };
    if (sql.includes('SELECT principal_id AS id')) {
      lookups.push(args);
      expect(args[0]).toBe(owner);
      return { rows: controllers.filter((id) => !args[1] || id > String(args[1]))
        .slice(0, Number(args[2])).map((id) => ({ id })) };
    }
    if (sql.includes('SELECT id FROM access.governance_report')) return { rows: [{ id: decision }] };
    if (sql.includes('SELECT 1 FROM access.safety_party_notice'))
      return { rowCount: notices.has(String(args[1])) ? 1 : 0 };
    if (sql.includes('INSERT INTO access.governance_case_credential')) credentials++;
    if (sql.includes('INSERT INTO access.safety_party_notice')) notices.add(String(args[2]));
    if (sql.includes('UPDATE access.safety_notice_job')) Object.assign(job, {
      phase: args[2], after_subject: args[3], subject: args[4], after_principal: args[5],
    });
    if (sql.includes('SELECT 1 FROM access.safety_notice_job')) return { rowCount: job.phase === 'done' ? 0 : 1 };
    return { rows: [] };
  } } as unknown as PoolClient;
  let completed = false;
  for (let step = 0; step < 8 && !completed; step++) {
    const before = notices.size;
    completed = await prepareDecisionNotices(client, decision, decision, unrecordedReasons, participants);
    expect(notices.size - before).toBeLessThanOrEqual(50);
  }
  expect(completed).toBe(true);
  expect(notices.size).toBe(53);
  expect(credentials).toBe(53);
  expect(lookups.some((args) => args[1] === controllers[49])).toBe(true);
  expect(lookups.every((args) => args[2] === 50)).toBe(true);
  await prepareDecisionNotices(client, decision, decision, unrecordedReasons, participants);
  expect(credentials).toBe(53);
  expect(f.reads.filter(({ sql }) => sql.includes('SELECT DISTINCT ?author'))
    .every(({ sql, maximum }) => sql.includes('LIMIT 1') && maximum === 16_384
      && !sql.includes('rv:member'))).toBe(true);
});

test('emitted Realm commands enforce authored SHACL and atomic guards in native Jena', async () => {
  const root = resolve(import.meta.dir, '../../..');
  mkdirSync(join(root, '.temp'), { recursive: true });
  const build = mkdtempSync(join(root, '.temp/realm-target-native-'));
  const cache = join(root, '.temp/realm-target-maven-cache');
  mkdirSync(cache, { recursive: true });
  const module = join(root, 'infra/jena/command-module');
  const image = /^FROM (\S+) AS module$/m.exec(readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8'))?.[1];
  if (!image) throw new Error('Pinned native builder missing');
  const cases: { name: string; command: CommandEnvelope; seed: string; mutation: string;
    expected: 'committed' | 'guard-unmatched' | 'invalid' }[] = [];
  const seed = (version: number, declared: boolean, realmHead = head) => `PREFIX rv: <${RV}>
    INSERT DATA {
      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product>
        rv:dataEpoch "realm-target-epoch" ; rv:routingEpoch "realm-target-routing" ; rv:sequence 0 . }
      GRAPH <${GRAPHS.current}> {
        <${space}> a rv:Space ; rv:owner <${owner}> ; rv:realmCapability <${realm}> ;
          <http://www.w3.org/2000/01/rdf-schema#label> "Native Realm"@en ; rv:disclosure rv:Private ; rv:listing "unlisted" .
        <${realm}> a rv:Realm ; rv:space <${space}> ; rv:head <${realmHead}> ; rv:realmState rv:Active ;
          rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ;
          rv:membershipPolicy <https://rezics.com/definition/realm-closed-v1> ;
          rv:reviewPolicy <https://rezics.com/definition/realm-open-v1> ; rv:historyVisibility "from-admission" .
        <urn:realm-native:attached-zone> a rv:Zone ; rv:defaultRealm <${realm}> ;
          rv:realmAttachedBy <${owner}> ; rv:realmAttachment <urn:realm-native:attachment> .
        <urn:realm-native:detached-zone> a rv:Zone ; rv:disclosure rv:Private .
        ${declared ? `<${space}> rv:definitionProfile <${profile(version)}> .
          <${realm}> rv:definitionProfile <${profile(version)}> .` : ''}
      }
      GRAPH <${GRAPHS.revisions}> {
        <urn:realm-native:detached-attachment> a rv:ZoneRealmAttachment ; rv:realm <${realm}> ;
          rv:zone <urn:realm-native:detached-zone> ; rv:attachmentState rv:Detached .
      }
    }`;
  const change = (removed: string, added = '') => `PREFIX rv: <${RV}> ${[
    removed ? `DELETE DATA { GRAPH <${GRAPHS.current}> { ${removed} } }` : '',
    added ? `INSERT DATA { GRAPH <${GRAPHS.current}> { ${added} } }` : '',
  ].filter(Boolean).join('; ')}`;
  for (const [version, declared] of [[1, false], [1, true], [2, true], [3, true]] as const) {
    const f = graph(version, declared);
    await f.effects.apply(operation, 1, target());
    cases.push({ name: `v${version}-${declared ? 'declared' : 'legacy'}`, command: f.commands[0]!,
      seed: seed(version, declared), mutation: '', expected: 'committed' });
  }
  const declaredCommand = cases[3]!.command;
  const legacyCommand = cases[0]!.command;
  for (const [name, mutation] of [
    ['stale-head', change(`<${realm}> rv:head <${head}> .`, `<${realm}> rv:head <${laterHead}> .`)],
    ['duplicate-head', change('', `<${realm}> rv:head <${laterHead}> .`)],
    ['retired', change(`<${realm}> rv:realmState rv:Active .`, `<${realm}> rv:realmState rv:Retired .`)],
    ['wrong-kind', change(`<${realm}> a rv:Realm .`, `<${realm}> a rv:Agent .`)],
    ['competing-primary-kind', change('', `<${realm}> a rv:Agent .`)],
    ['nonreciprocal', change(`<${space}> rv:realmCapability <${realm}> .`)],
    ['duplicate-space', change('', `<${realm}> rv:space <${space}-other> .`)],
    ['duplicate-reciprocal-space', change('', `<${space}-other> rv:realmCapability <${realm}> .`)],
    ['mismatched-profile', change(`<${space}> rv:definitionProfile <${profile(3)}> .`,
      `<${space}> rv:definitionProfile <${profile(2)}> .`)],
    ['missing-realm-profile', change(`<${realm}> rv:definitionProfile <${profile(3)}> .`)],
    ['missing-space-profile', change(`<${space}> rv:definitionProfile <${profile(3)}> .`)],
  ]) cases.push({ name, command: declaredCommand, seed: seed(3, true), mutation,
    expected: 'guard-unmatched' });
  for (const both of [false, true]) cases.push({ name: `legacy-${both ? 'both' : 'one'}-profile-appears`,
    command: legacyCommand, seed: seed(1, false), expected: 'guard-unmatched',
    mutation: change('', `<${realm}> rv:definitionProfile <${profile(1)}> .
      ${both ? `<${space}> rv:definitionProfile <${profile(1)}> .` : ''}`) });
  for (const [name, mutation] of [
    ['invalid-space-owner', change(`<${space}> rv:owner <${owner}> .`)],
    ['invalid-realm-policy', change(`<${realm}> rv:selectionPolicy
      <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> .`)],
  ]) cases.push({ name, command: declaredCommand, seed: seed(3, true), mutation, expected: 'invalid' });
  for (const component of ['title', 'name'] as const) {
    const f = graph();
    await f.effects.apply(operation, 1, { ...target(), component });
    cases.push({ name: `narrow-${component}`, command: f.commands[0]!, seed: seed(3, true),
      mutation: '', expected: 'committed' });
  }
  const release = graph();
  release.state.head = laterHead;
  await release.effects.apply(operation, 2, target(laterHead), { outcome: 'restore' });
  cases.push({ name: 'release-current-head', command: release.commands[0]!, seed: seed(3, true, laterHead),
    mutation: '', expected: 'committed' });
  cpSync(join(module, 'pom.xml'), join(build, 'pom.xml'));
  cpSync(join(module, 'src/main'), join(build, 'src/main'), { recursive: true });
  mkdirSync(join(build, 'profiles'));
  for (const version of [1, 2, 3]) cpSync(
    join(root, `generated/model/shapes/space-realm-v${version}.ttl`),
    join(build, `profiles/space-realm-v${version}.ttl`),
  );
  mkdirSync(join(build, 'tmp'));
  const java = join(build, 'src/test/java/com/rezics/jena');
  mkdirSync(java, { recursive: true });
  writeFileSync(join(build, 'cases.json'), JSON.stringify(cases));
  // Execute the emitted bytes through the native policy parser, staged TDB2
  // update, selected SHACL owner and receipt invariant. This is owner
  // interoperability evidence; it makes no HTTP or Access-fence claim.
  writeFileSync(join(java, 'RealmTargetOwnerContractTest.java'), `package com.rezics.jena;
import static org.junit.Assert.*;
import java.nio.file.*;
import java.util.*;
import org.apache.jena.atlas.json.*;
import org.apache.jena.graph.*;
import org.apache.jena.query.*;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.*;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.update.*;
import org.junit.Test;
public class RealmTargetOwnerContractTest {
  private static Node iri(String value) { return NodeFactory.createURI(value); }
  private static void phase(String value) {
    System.out.println("REALM_NATIVE_PHASE " + System.currentTimeMillis() + " " + value);
  }
  private static List<String> strings(JsonValue values) {
    List<String> result = new ArrayList<>();
    for (JsonValue value : values.getAsArray()) result.add(value.getAsString().value());
    return result;
  }
  @Test(timeout = 90_000) public void emittedOwnerBytesValidateAndFenceInTheWritingTransaction() throws Exception {
    phase("profiles-start");
    var scenarios = JSON.parseAny(Files.readString(Path.of("cases.json"))).getAsArray();
    Map<String, ProfileRegistry.Profile> profiles = new LinkedHashMap<>();
    // Load only the three requested reviewed artifacts, through the native
    // profile compiler; unrelated population shapes are outside this proof.
    for (JsonValue item : scenarios) for (JsonValue raw : item.getAsObject().get("command")
        .getAsObject().get("validations").getAsArray()) {
      JsonObject entry = raw.getAsObject();
      String id = entry.get("profile").getAsString().value();
      if (profiles.containsKey(id)) continue;
      Path file = Path.of("profiles", id + ".ttl");
      String sha = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
        .digest(Files.readAllBytes(file)));
      assertEquals(id, entry.get("sha256").getAsString().value(), sha);
      var model = ModelFactory.createDefaultModel();
      RDFDataMgr.read(model, file.toUri().toString(), Lang.TTL);
      profiles.put(id, new ProfileRegistry.Profile(sha, model, null));
      phase("profile-loaded " + id);
    }
    for (JsonValue item : scenarios) {
      JsonObject scenario = item.getAsObject(), command = scenario.get("command").getAsObject();
      String name = scenario.get("name").getAsString().value();
      String receipt = command.get("receipt").getAsString().value();
      String digest = command.get("digest").getAsString().value();
      String update = command.get("update").getAsString().value();
      String expected = scenario.get("expected").getAsString().value();
      phase(name + " tdb-open");
      var data = TDB2Factory.connectDataset(Files.createTempDirectory(
        Path.of(System.getProperty("java.io.tmpdir")), "realm-target-").toString()).asDatasetGraph();
      try {
        phase(name + " seed-start");
        data.begin(ReadWrite.WRITE);
        try {
          UpdateAction.parseExecute(scenario.get("seed").getAsString().value(), DatasetFactory.wrap(data));
          String mutation = scenario.get("mutation").getAsString().value();
          if (!mutation.isEmpty()) UpdateAction.parseExecute(mutation, DatasetFactory.wrap(data));
          data.commit();
        } finally { data.end(); }
        Set<org.apache.jena.sparql.core.Quad> preserved = new HashSet<>();
        data.begin(ReadWrite.READ);
        try {
          data.find(iri("${GRAPHS.current}"), Node.ANY, Node.ANY, Node.ANY).forEachRemaining(preserved::add);
          data.find(iri("${GRAPHS.revisions}"), iri("urn:realm-native:detached-attachment"), Node.ANY, Node.ANY)
            .forEachRemaining(preserved::add);
        } finally { data.end(); }
        phase(name + " command-parse");
        var plan = CommandPolicy.parse(update, receipt);
        String outcome = "guard-unmatched";
        data.begin(ReadWrite.WRITE);
        try {
          var before = CommandInvariant.readControl(data);
          var staged = new CommandOverlay(data);
          phase(name + " command-execute");
          UpdateAction.execute(plan.request(), DatasetFactory.wrap(staged));
          phase(name + " command-executed");
          if (staged.contains(iri(CommandPolicy.RECEIPTS), iri(receipt), Node.ANY, Node.ANY)) {
            outcome = "committed";
            for (JsonValue raw : command.get("validations").getAsArray()) {
              JsonObject entry = raw.getAsObject();
              String id = entry.get("profile").getAsString().value();
              var profile = profiles.get(id);
              assertEquals(name, profile.sha256(), entry.get("sha256").getAsString().value());
              var validation = new CommandService.Validation(id, profile,
                entry.get("shape").getAsString().value(), strings(entry.get("focus")),
                strings(entry.get("graphs")), Map.of());
              phase(name + " validate " + entry.get("shape").getAsString().value());
              if (CommandService.validateOne(staged, validation) != null) outcome = "invalid";
            }
            if (outcome.equals("committed")) {
              phase(name + " receipt-invariant");
              assertNull(name, CommandInvariant.check(staged, receipt, digest, plan, before));
              staged.apply(); data.commit();
            } else data.abort();
          } else data.abort();
        } finally { data.end(); }
        assertEquals(name, expected, outcome);
        data.begin(ReadWrite.READ);
        try {
          assertEquals(name, expected.equals("committed"),
            data.contains(iri(CommandPolicy.RECEIPTS), iri(receipt), Node.ANY, Node.ANY));
          assertEquals(name, expected.equals("committed") ? java.math.BigInteger.ONE : java.math.BigInteger.ZERO,
            CommandInvariant.readControl(data).sequence());
          Set<org.apache.jena.sparql.core.Quad> retained = new HashSet<>();
          data.find(iri("${GRAPHS.current}"), Node.ANY, Node.ANY, Node.ANY).forEachRemaining(retained::add);
          data.find(iri("${GRAPHS.revisions}"), iri("urn:realm-native:detached-attachment"), Node.ANY, Node.ANY)
            .forEachRemaining(retained::add);
          assertEquals(name + " preserves head, private visibility, settings and attachments", preserved, retained);
          assertFalse(name + " must not revive detached attachment", data.contains(
            iri("${GRAPHS.current}"), iri("urn:realm-native:detached-zone"), iri("${RV}defaultRealm"), iri("${realm}")));
          if (expected.equals("committed")) assertTrue(name, data.contains(iri(CommandPolicy.RECEIPTS),
            iri(receipt), iri("${RV}work"), iri("${realm}")));
        } finally { data.end(); }
        System.out.println("REALM_NATIVE_CASE " + name + " " + outcome);
      } finally { phase(name + " tdb-close"); data.close(); }
    }
  }
}
`);
  const dockerEnv = loadDockerEnvironment();
  const container = `rezics-realm-target-native-${randomUUID()}`;
  let nativePassed = false;
  try {
    const child = Bun.spawn(['docker', 'run', '--rm', '--name', container,
      '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--memory', '1g', '--cpus', '2', '--volume', `${build}:/build`,
      '--volume', `${cache}:/maven-cache`, '--env', 'MAVEN_CONFIG=/maven-cache',
      '--env', 'MAVEN_OPTS=-Xmx128m',
      '--env', 'JAVA_TOOL_OPTIONS=-XX:+UseSerialGC -XX:ActiveProcessorCount=2 -Djava.io.tmpdir=/build/tmp',
      '--workdir', '/build', image, 'mvn', '-B', '-ntp', '-Dmaven.repo.local=/maven-cache',
      '-DargLine=-Xmx384m', '-Dtest=RealmTargetOwnerContractTest', 'test'], {
      cwd: root, env: dockerEnv, stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const log = join(root, '.temp/goal/realm-target-native.log');
    mkdirSync(join(root, '.temp/goal'), { recursive: true });
    writeFileSync(log, `Native probe artifacts: ${build}\n${stdout}\n${stderr}`);
    expect(code, `Native Realm owner probe: ${log}`).toBe(0);
    expect(stdout).toContain('Tests run: 1, Failures: 0, Errors: 0');
    expect(stdout.split('\n').filter((line) => line.startsWith('REALM_NATIVE_CASE '))).toHaveLength(cases.length);
    nativePassed = true;
  } finally {
    const cleanup = Bun.spawn(['docker', 'rm', '-f', container], {
      env: dockerEnv, stdout: 'ignore', stderr: 'ignore', timeout: 30_000,
    });
    await cleanup.exited;
    if (nativePassed) rmSync(build, { recursive: true, force: true });
  }
}, 280_000);

async function responseJson<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** composeMain installs governanceServices; only Account's token verification is
 * substituted by this isolated integration fixture. Evidence and effects read Jena. */
async function productionRealm(label: string) {
  const stack = await startMediaStack(label);
  const editor = await stack.member(`${label}-owner`);
  const staff = await stack.member(`${label}-staff`);
  async function grant(member: typeof editor, scope: string, action: string, actor = member.actor) {
    await grantFixtureAuthority(stack.accessPool, { scope, requireDispatch: true,
      representations: [{ principalId: member.principalId, actor, action, lifetime: 'infinity' }],
      grant: { actor, action, lifetime: 'infinity' } });
  }
  try {
    await grant(editor, 'space:create:root', 'space.create');
    const created = await responseJson<{ realm: string; space: string }>(await editor.send('POST',
      '/v1/spaces', { profile: 'space-realm-v1', name: label, capabilities: ['realm'],
        actingSubject: editor.actor }), 201);
    await grant(editor, `realm:profile:${created.realm}`, 'realm.profile.publish');
    const published = await responseJson<{ revision: string }>(await editor.send('PUT',
      `/v1/realms/${created.realm.slice(-36)}/profile`, { profile: 'realm-public-profile-v2',
        expectedHead: null, actingSubject: editor.actor, publication: {
          name: { original: 'en', labels: { en: label } }, description: null,
          iconSelection: null, bannerSelection: null, rules: [], moderators: [],
          count: { kind: 'unknown', value: null },
        } }), 201);
    const heads = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?public WHERE {
      GRAPH <${GRAPHS.current}> { <${created.realm}> rv:head ?head ; rv:publicProfileHead ?public }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    expect(heads).toHaveLength(1);
    const realmHead = heads[0]!.head!.value;
    expect(heads[0]!.public!.value).toBe(published.revision);
    expect(published.revision).not.toBe(realmHead);
    await grant(staff, 'governance:platform', DECIDE_ACTION.content_report);
    await grant(staff, 'governance:platform', 'governance.rule.publish');
    const governance = stack.composition.dependencies.governance!;
    const rule = await governance.rules.publish(staff.principal, {
      ref: `urn:rule:${randomUUID()}`, scopeId: 'governance:platform', actingSubject: staff.actor,
      expectedRevision: null, document: { purpose: 'Review Realm disclosure' }, idempotencyKey: randomUUID(),
    });
    const report = await responseJson<{ reportId: string; caseId: string }>(await stack.call('POST',
      '/v1/public-reports', { key: randomUUID(), body: { profile: 'public-report-v1',
        target: created.realm, category: 'harassment', statement: 'Review the published Realm profile.',
        contentLanguage: 'en' } }), 201);
    const basis = (await stack.accessPool.query<{ generation: string; evidence_digest: string }>(
      `SELECT c.generation::text,r.evidence_digest FROM access.governance_case c
       JOIN access.governance_report r ON r.case_id=c.id WHERE r.id=$1`, [report.reportId])).rows[0]!;
    const retained = (await stack.accessPool.query<{ revision: string; state: string }>(
      'SELECT revision,state FROM access.governance_evidence WHERE report_id=$1', [report.reportId])).rows;
    expect(retained).toEqual([{ revision: published.revision, state: 'available' }]);
    await governance.store.safety.claim(staff.principal, staff.actor, report.caseId);
    const input: DecisionInput = {
      caseId: report.caseId, expectedGeneration: basis.generation, actingSubject: staff.actor,
      outcome: 'restrict', targets: [{ owner: 'graph', resource: created.realm, component: 'record',
        locator: null, scopeKind: 'component', revision: null, expectedHead: realmHead, effect: 'disclosure' }],
      rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest }, evidenceDigest: basis.evidence_digest,
      reversesDecisionId: null, answersStepId: null, rationale: null, disclosure: 'private',
      idempotencyKey: randomUUID(), reasons: { ...unrecordedReasons, automation: false,
        facts: 'Private retained evidence was reviewed.', scope: 'The Realm record.', duration: 'Until review.' },
    };
    return { stack, editor, staff, grant, governance, realmHead, published, report, input, ...created };
  } catch (error) { await stack.stop(); throw error; }
}

test('production Realm ownership rejects an extra nonreciprocal Space before discovery or decision acceptance', async () => {
  const f = await productionRealm('realm-reciprocal-proof');
  try {
    const stranger = await f.stack.member('realm-unrelated-space-owner');
    const unrelatedSpace = `https://rezics.com/id/${randomUUID()}`;
    await f.stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH <${GRAPHS.current}> {
      <${f.realm}> rv:space <${unrelatedSpace}> .
      <${unrelatedSpace}> a rv:Space ; rv:owner <${stranger.actor}> .
    } }`);
    await expect(resolveRealmProfile(f.stack.env, f.realm)).rejects.toThrow();
    await expect(ownerTargetHeads({ graph: f.stack.env }).realmBasis!(f.input.targets[0]!)).rejects.toThrow();
    await expect(graphNoticeParticipants(f.stack.env).participants!(f.input.targets[0]!, null, 1))
      .rejects.toThrow();
    await expect(f.governance.store.acceptDecision(f.staff.principal, f.input)).rejects.toThrow();
    expect((await f.stack.accessPool.query('SELECT 1 FROM access.moderation_decision WHERE case_id=$1',
      [f.report.caseId])).rowCount).toBe(0);
    expect((await f.stack.accessPool.query('SELECT 1 FROM access.safety_party_notice WHERE case_id=$1',
      [f.report.caseId])).rowCount).toBe(0);
    const receipts = (await f.stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt WHERE {
      GRAPH <${GRAPHS.receipts}> { ?receipt rv:moderationTarget <${f.realm}> }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    expect(receipts).toHaveLength(0);
  } finally { await f.stack.stop(); }
}, 120_000);

test('production Realm decision creates owner-controller notices and replays one mail receipt per recipient', async () => {
  const f = await productionRealm('realm-notice-producer');
  try {
    const controller = await f.stack.member('additional-space-owner-controller');
    const unrelated = await f.stack.member('unrelated-realm-member');
    await f.grant(controller, 'work:create:root', 'agent.control', f.editor.actor);
    await f.grant(unrelated, 'work:create:root', 'access.membership.consent');
    for (const action of ['realm.members.manage', 'realm.settings.manage'])
      await f.grant(f.editor, `governance:realm:${f.realm}`, action);
    const deps = f.stack.composition.dependencies;
    const settings = await deps.realmAdmin!.settings(f.editor.principal, f.realm, f.editor.actor, f.stack.env);
    const policy = (await f.stack.accessPool.query<{ revision: string; terms_revision: string }>(
      "SELECT revision::text,terms_revision FROM access.membership_policy WHERE kind='realm' AND owner_subject=$1",
      [f.realm])).rows[0]!;
    const consent = await deps.membershipConsents!.issue({ principal: unrelated.principal, kind: 'realm',
      ownerSubject: f.realm, memberSubject: unrelated.actor, expectedGeneration: '0',
      expectedPolicyRevision: policy.revision, termsRevision: policy.terms_revision,
      idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    await deps.realmAdmin!.changeMember(f.editor.principal, f.realm, {
      actingSubject: f.editor.actor, expectedGeneration: settings.generation, member: unrelated.actor,
      expectedMembershipGeneration: '0', action: 'add', consent: consent.consentReference,
      durationSeconds: null, reason: 'Join the Realm without controlling its Space owner',
    }, randomUUID(), f.stack.env);
    const accepted = await f.governance.store.acceptDecision(f.staff.principal, f.input);
    expect(accepted.operation.status).toBe('accepted');
    expect((await f.stack.accessPool.query('SELECT 1 FROM access.safety_notice_job WHERE decision_id=$1',
      [accepted.decisionId])).rowCount).toBe(1);
    const sent: SafetyNoticeMail[] = [];
    const mail = new SafetyDecisionMail(f.stack.accessPool, f.editor.principal.issuer,
      async input => { sent.push(input); }, graphNoticeParticipants(f.stack.env), 1);
    let complete = false;
    for (let page = 0; page < 20 && !complete; page++) complete = await mail.enqueuePage(accepted.decisionId);
    expect(complete).toBe(true);
    const notices = (await f.stack.accessPool.query<{ principal_id: string }>(
      'SELECT principal_id FROM access.safety_party_notice WHERE decision_id=$1 ORDER BY principal_id',
      [accepted.decisionId])).rows.map(row => row.principal_id);
    expect(notices).toEqual([f.editor.principalId, controller.principalId].sort());
    expect(notices).not.toContain(unrelated.principalId);
    expect(sent.map(input => 'userId' in input.recipient ? input.recipient.userId : null).sort())
      .toEqual([f.editor.principal.subject, controller.principal.subject].sort());
    expect(sent.every(input => input.credential && input.reasons?.facts === f.input.reasons!.facts)).toBe(true);
    const confirmed = await f.governance.store.decide(f.staff.principal, f.input);
    const replay = await f.governance.store.decide(f.staff.principal, f.input);
    expect(replay.decisionId).toBe(confirmed.decisionId);
    expect(await mail.enqueuePage(accepted.decisionId)).toBe(true);
    expect(sent).toHaveLength(2);
    expect((await f.stack.accessPool.query('SELECT 1 FROM access.safety_notice_mail_receipt WHERE decision_id=$1',
      [accepted.decisionId])).rowCount).toBe(2);
    expect((await f.stack.accessPool.query('SELECT 1 FROM access.governance_case_credential WHERE case_id=$1',
      [f.report.caseId])).rowCount).toBe(3); // One reporter and two affected-party credentials.
  } finally { await f.stack.stop(); }
}, 120_000);

test('production Realm dispatch refuses a competing primary kind introduced after its owner basis read', async () => {
  const f = await productionRealm('realm-primary-kind-race');
  const original = f.stack.fuseki.commandWithReceipt;
  let raced = false;
  try {
    f.stack.fuseki.commandWithReceipt = async command => {
      if (command.update.includes('a rv:ModerationEffect') && command.update.includes(`<${f.realm}>`)) {
        raced = true;
        await f.stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH <${GRAPHS.current}> {
          <${f.realm}> a rv:Agent } }`);
      }
      return original.call(f.stack.fuseki, command);
    };
    const result = await f.governance.store.decide(f.staff.principal, f.input);
    expect(raced).toBe(true);
    expect(result.operation.status).not.toBe('completed');
    expect((await f.stack.accessPool.query<{ state: string }>(
      'SELECT state FROM access.safety_decision_effect WHERE decision_id=$1', [result.decisionId])).rows)
      .toEqual([{ state: 'failed' }]);
    expect((await f.stack.accessPool.query('SELECT 1 FROM access.governance_enforcement WHERE resource=$1',
      [f.realm])).rowCount).toBe(0);
    expect((await f.stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.receipts}> {
      ?receipt rv:moderationTarget <${f.realm}> } }`, 1024)).boolean).toBe(false);
    expect((await f.stack.accessPool.query("SELECT 1 FROM access.outbox WHERE kind='moderation.decided' AND moderation_decision_id=$1",
      [result.decisionId])).rowCount).toBe(0);
  } finally { f.stack.fuseki.commandWithReceipt = original; await f.stack.stop(); }
}, 120_000);

test('production Realm moderationTarget receipt refreshes the directory without a publication slot', async () => {
  const f = await productionRealm('realm-receipt-directory');
  try {
    const read = async () => {
      const position = (await f.stack.accessPool.query<{ phase: string }>(
        'SELECT phase FROM access.realm_directory_position WHERE singleton')).rows[0]!;
      return position.phase === 'idle' ? f.stack.call('GET', '/v1/realms') : new Response('', { status: 503 });
    };
    await waitForRealmDirectory(f.stack.env, read, page => page.items.some(item => item.id === f.realm));
    expect((await f.stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.current}> {
      ?slot a rv:RealmPublicationSlot ; rv:realm <${f.realm}> } }`, 1024)).boolean).toBe(false);
    // A source-only fixture change has no receipt of its own. The real owner
    // decision below must identify this exact Realm to incremental discovery.
    await f.stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH <${GRAPHS.current}> {
      <${f.space}> rv:listing ?listing } } INSERT { GRAPH <${GRAPHS.current}> {
      <${f.space}> rv:listing "unlisted" } } WHERE { GRAPH <${GRAPHS.current}> {
      <${f.space}> rv:listing ?listing } }`);
    const confirmed = await f.governance.store.decide(f.staff.principal, f.input);
    expect(confirmed.operation.status).toBe('completed');
    const receipts = (await f.stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?realm ?space WHERE {
      GRAPH <${GRAPHS.receipts}> { ?receipt rv:moderationTarget <${f.realm}> ; rv:work <${f.realm}> .
        OPTIONAL { ?receipt rv:realm ?realm } OPTIONAL { ?receipt rv:space ?space } }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.realm).toBeUndefined();
    expect(receipts[0]?.space).toBeUndefined();
    await waitForRealmDirectory(f.stack.env, read, page => page.items.every(item => item.id !== f.realm));
    expect((await f.stack.accessPool.query(`SELECT d.realm FROM access.realm_directory d
      JOIN access.realm_directory_position p ON p.generation=d.generation WHERE p.singleton AND d.realm=$1`,
      [f.realm])).rowCount).toBe(0);
  } finally { await f.stack.stop(); }
}, 120_000);

for (const narrow of ['title', 'search', 'publication', 'exact_revision'] as const) {
  test(`production Realm ${narrow} restriction leaves its ordinary Works route available`, async () => {
    const f = await productionRealm(`realm-narrow-${narrow}`);
    try {
      const ordinary = () => f.stack.call('GET', `/v1/realms/${f.realm.slice(-36)}/works`);
      const before = await responseJson<{ items: unknown[] }>(await ordinary(), 200);
      const candidate = { ...f.input.targets[0]!,
        ...(narrow === 'title' ? { component: 'title' as const } : {}),
        ...(narrow === 'search' ? { effect: 'search' as const } : {}),
        ...(narrow === 'publication' ? { effect: 'publication' as const } : {}),
        ...(narrow === 'exact_revision' ? { scopeKind: 'exact_revision' as const,
          revision: f.published.revision } : {}),
      };
      const confirmed = await f.governance.store.decide(f.staff.principal, { ...f.input, targets: [candidate] });
      expect(confirmed.operation.status).toBe('completed');
      const after = await responseJson<{ items: unknown[] }>(await ordinary(), 200);
      expect(after.items).toEqual(before.items);
      expect((await f.stack.accessPool.query(`SELECT 1 FROM access.governance_enforcement
        WHERE resource=$1 AND component='record' AND effect='disclosure' AND revision IS NULL`,
        [f.realm])).rowCount).toBe(0);
    } finally { await f.stack.stop(); }
  }, 120_000);
}
