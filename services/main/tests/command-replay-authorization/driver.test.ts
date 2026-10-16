import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorityLosses, buildReplayScenario, type AuthorityLoss, type NonReplayEntry, type ReplayEntry, type AnyReplayEntry, type ResourceScenario } from './authority-classes.ts';
import { assertCurrentAuthority, nonReplayControls, replayControls, registerReplayCases, validateReplayEntry } from './driver.ts';
import { commandCoverage, discoverPublicCommands, type PublicCommand, type ReplayArea } from './public-callers.ts';

class Denied extends Error {}
class Conflict extends Error {}

// This owner checks a real authority state independently of its saved receipt.
// The defect switch puts the receipt lookup before that check for one key.
class SavedOwner {
  credential = 'case-credential';
  revoked = false;
  expiresAt = 100;
  clock = 0;
  active = true;
  consumed = false;
  realmMember = true;
  statementAccepted = true;
  answerVersion = 1;
  minted = 0;
  refusedWrites = 0;
  commandEffects = 0;
  saved = new Map<string, { body: string; result: { resource: string; version: number } }>();
  constructor(readonly resourceIdentity: boolean, readonly leakKey?: string,
    readonly changedBody: 'saved-result' | 'conflict' = 'saved-result', readonly corrupt = false) {}

  async execute(key: string, body: string, credential = this.credential) {
    const receipt = this.saved.get(this.resourceIdentity ? 'realm-init:realm' : key);
    if (receipt && key === this.leakKey && body === 'original') return receipt.result;
    if (credential !== this.credential || this.revoked || this.clock >= this.expiresAt || !this.active || this.consumed
      || !this.realmMember || !this.statementAccepted) {
      if (this.corrupt) this.refusedWrites += 1;
      throw new Denied('current authority unavailable');
    }
    if (receipt) {
      if (body !== receipt.body && (!this.resourceIdentity || this.changedBody === 'conflict')) throw new Conflict('body conflict');
      return { ...receipt.result, replayed: true };
    }
    this.commandEffects += 1;
    const result = { resource: 'realm', version: this.answerVersion };
    this.saved.set(this.resourceIdentity ? 'realm-init:realm' : key, { body, result });
    return result;
  }

  async lose(loss: AuthorityLoss) {
    if (loss === 'expired') this.clock = this.expiresAt;
    else if (loss === 'revoked') this.revoked = true;
    else if (loss === 'principal-inactive') this.active = false;
    else if (loss === 'consumed') this.consumed = true;
    else if (loss === 'realm-membership-lost') this.realmMember = false;
    else if (loss === 'statement-not-accepted') this.statementAccepted = false;
    else throw new Error(`Unknown loss: ${loss}`);
  }

  scenario(credential?: string) {
    return {
      command: (fresh?: boolean, changed?: boolean) => this.execute(fresh ? 'another-key' : 'original-key', changed ? 'changed' : 'original', credential),
      lose: (loss: AuthorityLoss) => this.lose(loss),
      snapshot: async () => ({ receipts: [...this.saved.entries()], refusedWrites: this.refusedWrites, commandEffects: this.commandEffects }),
      advance: async () => { this.answerVersion += 1; },
    };
  }

  resourceScenario(): ResourceScenario {
    const { command: _command, ...fixture } = this.scenario();
    return { ...fixture, requestKeys: ['original-key', 'another-key'],
      commandWithKey: (key, changed) => this.execute(key, changed ? 'changed' : 'original') };
  }
}

const metadata = {
  operation: 'PUT /v1/example', scope: 'example', action: 'example.write', family: 'stand-in owner',
  owners: ['modules/example.ts#SavedOwner.execute'], subcases: ['saved receipt'],
  denied: Denied, conflict: Conflict, registration: 'turned' as const,
};

function principalEntry(leakKey?: string, corrupt = false): Extract<AnyReplayEntry, { authorityClass: 'principal' }> {
  return { ...metadata, authorityClass: 'principal', requestBuilder: async () => new SavedOwner(false, leakKey, 'saved-result', corrupt).scenario() };
}
function capabilityEntry(leakKey?: string, singleUse = true, corrupt = false): Extract<AnyReplayEntry, { authorityClass: 'capability' }> {
  return { ...metadata, authorityClass: 'capability', singleUse,
    credential: async () => 'private-case-credential',
    requestBuilder: async (_subcase, _loss, credential) => {
      expect(credential).toBe('private-case-credential');
      const owner = new SavedOwner(false, leakKey, 'saved-result', corrupt);
      owner.credential = credential;
      return owner.scenario(credential);
    } };
}
function resourceEntry(leakKey?: string, changedBody: 'saved-result' | 'conflict' = 'saved-result', corrupt = false): Extract<AnyReplayEntry, { authorityClass: 'resource-identity' }> {
  return { ...metadata, authorityClass: 'resource-identity', resourceIdentity: 'realm-init:<Realm>',
    changedBody: changedBody === 'conflict' ? { refusal: Conflict } : 'saved-result',
    requestBuilder: async () => new SavedOwner(true, leakKey, changedBody, corrupt).resourceScenario() };
}

function realmMembershipEntry(leakKey?: string, corrupt = false): Extract<AnyReplayEntry, { authorityClass: 'realm-membership' }> {
  return { ...metadata, authorityClass: 'realm-membership',
    requestBuilder: async () => new SavedOwner(false, leakKey, 'saved-result', corrupt).scenario() };
}
function statementAcceptanceEntry(leakKey?: string, corrupt = false): Extract<AnyReplayEntry, { authorityClass: 'statement-acceptance' }> {
  return { ...metadata, authorityClass: 'statement-acceptance',
    requestBuilder: async () => new SavedOwner(false, leakKey, 'saved-result', corrupt).scenario() };
}

async function prove(entry: AnyReplayEntry, loss: AuthorityLoss) {
  assertCurrentAuthority(entry, await replayControls(entry, 'saved receipt', loss));
}

// Area factories pass an indexed class variable instead of a literal. Keep
// their builder, command and loss callbacks contextually typed without edits.
function legacyFactory(authorityClass: ReplayEntry['authorityClass']): ReplayEntry {
  return { ...metadata, authorityClass, losses: ['revoked'], family: `legacy variable ${authorityClass}`,
    requestBuilder: async (_subcase, loss) => {
      const owner = new SavedOwner(false);
      const fixture = owner.scenario();
      return { ...fixture, command: async (fresh, changed) => fixture.command(fresh, changed),
        lose: async () => owner.lose(loss) };
    } };
}
registerReplayCases((['controller', 'domain-grant'] as const).map(legacyFactory));
registerReplayCases([{ ...legacyFactory('domain-grant'), family: 'legacy registered saved disclosure',
  registration: 'registered-failing', requestBuilder: async () => new SavedOwner(false, 'original-key').scenario() }]);

const evidenceRoot = resolve(import.meta.dir, '../../../../.temp/goal/replay-driver');
mkdirSync(evidenceRoot, { recursive: true });
const evidence = mkdtempSync(join(evidenceRoot, 'stand-ins-'));
writeFileSync(join(evidence, 'source.json'), JSON.stringify({ qaRun: process.env.REZICS_QA_RUN_ID ?? null,
  sources: Object.fromEntries(['authority-classes.ts', 'driver.ts', 'driver.test.ts', 'fixtures.ts'].map(file =>
    [file, createHash('sha256').update(readFileSync(join(import.meta.dir, file))).digest('hex')])),
}, null, 2), { flag: 'wx' });
console.log(`Replay driver stand-in evidence: ${evidence}`);

registerReplayCases([realmMembershipEntry(), statementAcceptanceEntry()].map(entry => ({
  ...entry, family: `current ${entry.authorityClass}`,
})), evidence);
registerReplayCases([realmMembershipEntry('original-key'), statementAcceptanceEntry('original-key')].map(entry => ({
  ...entry, family: `disclosing ${entry.authorityClass}`, registration: 'registered-failing' as const,
})), evidence);

test('legacy factory typing cannot bypass declarations for a new authority class', () => {
  expect(() => validateReplayEntry(legacyFactory('principal'))).toThrow();
  expect(() => validateReplayEntry(legacyFactory('capability'))).toThrow();
  expect(() => validateReplayEntry(legacyFactory('resource-identity'))).toThrow();
});

for (const makeEntry of [principalEntry, capabilityEntry, resourceEntry, realmMembershipEntry, statementAcceptanceEntry]) {
  const sample = makeEntry();
  for (const loss of authorityLosses(sample)) {
    test(`${sample.authorityClass} / ${loss}: current refusal passes and a saved disclosure fails`, async () => {
      const current = makeEntry();
      const passing = await replayControls(current, 'saved receipt', loss);
      assertCurrentAuthority(current, passing);
      const broken = makeEntry('original-key');
      const controls = await replayControls(broken, 'saved receipt', loss);
      expect(() => assertCurrentAuthority(broken, controls)).toThrow();
      writeFileSync(join(evidence, `${sample.authorityClass}-${loss}.json`),
        JSON.stringify({ passing, disclosing: controls }, (_key, value: unknown) => value instanceof Error
          ? { name: value.name, message: value.message } : value, 2), { flag: 'wx' });
    });
  }
}

for (const entry of [principalEntry(undefined, true), capabilityEntry(undefined, true, true), resourceEntry(undefined, 'saved-result', true),
  realmMembershipEntry(undefined, true), statementAcceptanceEntry(undefined, true)]) {
  for (const loss of authorityLosses(entry)) test(`${entry.authorityClass} / ${loss}: refusal must preserve stored state`, async () => {
    await expect(prove(entry, loss)).rejects.toThrow();
  });
}

for (const [makeEntry, loss] of [[realmMembershipEntry, 'realm-membership-lost'],
  [statementAcceptanceEntry, 'statement-not-accepted']] as const) {
  test(`${loss}: dispatches exactly the named loss without ending a credential or grant`, async () => {
    const owner = new SavedOwner(false);
    const dispatched: AuthorityLoss[] = [];
    const entry = makeEntry();
    entry.requestBuilder = async (_subcase: string, requested: AuthorityLoss) => {
      expect(requested).toBe(loss);
      return { ...owner.scenario(), lose: async (reduction: AuthorityLoss) => { dispatched.push(reduction); await owner.lose(reduction); } };
    };
    expect(authorityLosses(entry)).toEqual([loss]);
    await prove(entry, loss);
    expect(dispatched).toEqual([loss]);
    expect(owner.realmMember).toBe(loss !== 'realm-membership-lost');
    expect(owner.statementAccepted).toBe(loss !== 'statement-not-accepted');
    expect(owner.active).toBe(true);
    expect(owner.revoked).toBe(false);
    expect(owner.clock).toBeLessThan(owner.expiresAt);
    expect(owner.consumed).toBe(false);
  });
  test(`${loss}: ordinary refusal class and message must match exactly`, async () => {
    for (const wrong of [new Error('current authority unavailable'), new Denied('different refusal')]) {
      const entry = makeEntry();
      entry.requestBuilder = async () => {
        const fixture = new SavedOwner(false).scenario();
        return { ...fixture, command: async (fresh, changed) => {
          try { return await fixture.command(fresh, changed); }
          catch (error) { if (!fresh && !changed && error instanceof Denied) throw wrong; throw error; }
        } };
      };
      await expect(prove(entry, loss)).rejects.toThrow();
    }
  });
  test(`${loss}: rejects empty, duplicate, wrong-class and invented expiry losses`, async () => {
    for (const losses of [[], [loss, loss], ['expired'], ['revoked'],
      [loss === 'realm-membership-lost' ? 'statement-not-accepted' : 'realm-membership-lost']]) {
      const entry = { ...makeEntry(), losses } as AnyReplayEntry;
      expect(() => validateReplayEntry(entry)).toThrow();
    }
    await expect(buildReplayScenario(makeEntry(), 'saved receipt', 'revoked')).rejects.toThrow('Unregistered');
    await expect(buildReplayScenario(principalEntry(), 'saved receipt', loss)).rejects.toThrow('Unregistered');
    await expect(buildReplayScenario(capabilityEntry(), 'saved receipt', loss)).rejects.toThrow('Unregistered');
  });
}
test('resource identity refuses the other request key after loss too', async () => {
  await expect(prove(resourceEntry('another-key'), 'revoked')).rejects.toThrow();
});
test('resource identity accepts the declared changed-body conflict', async () => {
  await prove(resourceEntry(undefined, 'conflict'), 'revoked');
});
test('resource identity checks an explicitly declared changed-body answer', async () => {
  const entry = resourceEntry();
  entry.changedBody = { result: { resource: 'realm', version: 2 } };
  entry.requestBuilder = async () => {
    const fixture = new SavedOwner(true).resourceScenario();
    return { ...fixture, commandWithKey: async (key, changed) => {
      const result = await fixture.commandWithKey(key, changed);
      return changed ? { resource: 'realm', version: 2 } : result;
    } };
  };
  await prove(entry, 'revoked');
  entry.changedBody = { result: { resource: 'realm', version: 3 } };
  await expect(prove(entry, 'revoked')).rejects.toThrow();
});
test('resource identity rejects an owner that actually deduplicates by request key', async () => {
  const entry = resourceEntry();
  entry.requestBuilder = async () => new SavedOwner(false).resourceScenario();
  await expect(prove(entry, 'revoked')).rejects.toThrow();
});
test('a resource repeat that creates another answer is a defect', async () => {
  const entry = resourceEntry();
  entry.requestBuilder = async () => {
    const owner = new SavedOwner(true);
    const fixture = owner.resourceScenario();
    return { ...fixture, commandWithKey: async (key, changed) => {
      owner.saved.clear();
      owner.answerVersion += 1;
      return fixture.commandWithKey(key, changed);
    } };
  };
  await expect(prove(entry, 'revoked')).rejects.toThrow();
});

test('capability retries may retain a newly minted recovery credential before authority loss', async () => {
  const entry = capabilityEntry(undefined, false);
  entry.requestBuilder = async (_subcase, _loss, credential) => {
    const owner = new SavedOwner(false);
    owner.credential = credential;
    const fixture = owner.scenario(credential);
    return { ...fixture, snapshot: async () => ({ stored: await fixture.snapshot(), issuedCredentials: owner.minted }),
      command: async (fresh, changed) => ({
      ...await fixture.command(fresh, changed) as object, credential: `minted-${++owner.minted}`,
    }) };
  };
  entry.resultIdentity = result => {
    const { credential: _credential, replayed: _replayed, ...receipt } = result as Record<string, unknown>;
    return receipt;
  };
  await prove(entry, 'revoked');
});
test('principal and single-use capability entries cannot omit their loss witnesses', () => {
  const principal = principalEntry();
  principal.losses = ['revoked'];
  expect(() => validateReplayEntry(principal)).toThrow();
  const capability = capabilityEntry();
  capability.losses = ['expired', 'revoked'];
  expect(() => validateReplayEntry(capability)).toThrow();
  expect(authorityLosses(capabilityEntry(undefined, false))).toEqual(['expired', 'revoked']);
});

function nonReplayEntry(saved = false): NonReplayEntry {
  return { operation: metadata.operation, family: 'repeat execution', owners: metadata.owners,
    reason: 'The operation performs another execution without retaining a keyed receipt.', subcases: ['repeat'],
    requestBuilder: async () => {
      let executions = 0;
      return { command: async () => ({ executions: saved ? executions ||= 1 : ++executions }),
        snapshot: async () => ({ executions }), repeatResult: { executions: 2 }, afterRepeat: { executions: 2 } };
    } };
}
test('non-replay executes again and checks the declared repeated answer', async () => {
  await nonReplayControls(nonReplayEntry(), 'repeat');
  await expect(nonReplayControls(nonReplayEntry(true), 'repeat')).rejects.toThrow();
  const wrongAnswer = nonReplayEntry();
  wrongAnswer.requestBuilder = async () => ({ command: async () => 'wrong', snapshot: async () => 0,
    repeatResult: 'declared', afterRepeat: 2 });
  await expect(nonReplayControls(wrongAnswer, 'repeat')).rejects.toThrow();
});
test('a declared repeat answer alone cannot conceal an unchanged saved receipt', async () => {
  const entry = nonReplayEntry(true);
  entry.requestBuilder = async () => ({ command: async () => ({ executions: 1 }), snapshot: async () => ({ executions: 1 }),
    repeatResult: { executions: 1 }, afterRepeat: { executions: 1 } });
  await expect(nonReplayControls(entry, 'repeat')).rejects.toThrow();
});

const command = (operation: string, saved: boolean, idempotencyKey = saved): PublicCommand => ({
  operation, caller: 'routes/example.ts', paths: saved ? [['modules/example.ts#SavedOwner.execute']] : [],
  reachableOwners: metadata.owners, idempotencyKey,
});
const area = (overrides: Partial<ReplayArea> = {}): ReplayArea => ({ moduleOwners: ['example'],
  coveredOperations: [], uncoveredOperations: [], replayEntries: [], ...overrides });

test('ratchet counts executable non-replay and rejects duplicate, missing and rising classifications', () => {
  const saved = command('PUT /v1/uncovered', true);
  const repeated = command(metadata.operation, false);
  const entries = area({ uncoveredOperations: [saved.operation], nonReplayEntries: [nonReplayEntry()] });
  const coverage = commandCoverage([saved, repeated], [entries], 1);
  expect(coverage.nonReplay).toEqual([metadata.operation]);
  expect(coverage.uncovered).toEqual([saved.operation]);
  expect(coverage.inventory).toHaveLength(2);
  expect(() => commandCoverage([saved, repeated], [entries], 0)).toThrow('exceeds baseline');
  expect(() => commandCoverage([saved], [area()], 1)).toThrow('Unclassified');
  expect(() => commandCoverage([saved], [area({ uncoveredOperations: [saved.operation, saved.operation] })], 2)).toThrow('exactly one');
  expect(() => commandCoverage([repeated], [area({ coveredOperations: [repeated.operation],
    replayEntries: [principalEntry()], nonReplayEntries: [nonReplayEntry()] })], 1)).toThrow('exactly one');
  expect(() => commandCoverage([saved], [area({ coveredOperations: [saved.operation] })], 1)).toThrow('no replay entry');
});
test('non-replay classification rejects key contracts and saved-result owners', () => {
  const entries = [area({ nonReplayEntries: [nonReplayEntry()] })];
  expect(() => commandCoverage([command(metadata.operation, false, true)], entries, 0)).toThrow('idempotency key');
  expect(() => commandCoverage([command(metadata.operation, true, false)], entries, 0)).toThrow('saved-result path');
});
test('ratchet retains an executed replay entry even when the static saved-result trace is incomplete', () => {
  const entries = area({ coveredOperations: [metadata.operation], replayEntries: [principalEntry()] });
  expect(commandCoverage([command(metadata.operation, false)], [entries], 0).covered).toEqual([metadata.operation]);
  expect(commandCoverage([], [entries], 0).covered).toEqual([metadata.operation]);
});
test('partial authority witnesses remain uncovered until all owner paths are covered', () => {
  const entries = area({ uncoveredOperations: [metadata.operation], replayEntries: [principalEntry()] });
  const coverage = commandCoverage([command(metadata.operation, true)], [entries], 1);
  expect(coverage.covered).toEqual([]);
  expect(coverage.uncovered).toEqual([metadata.operation]);
  expect(() => commandCoverage([command(metadata.operation, true)], [entries], 0)).toThrow('exceeds baseline');
});
test('non-replay entries must name executable cases, a reason and a discovered owner', () => {
  const repeated = command(metadata.operation, false);
  for (const overrides of [{ reason: '' }, { subcases: [] }, { owners: ['modules/missing.ts#Owner.execute'] }]) {
    const entry = { ...nonReplayEntry(), ...overrides };
    expect(() => commandCoverage([repeated], [area({ nonReplayEntries: [entry] })], 0)).toThrow();
  }
});

test('discovery reads the contract key and saved-result path separately from non-replay owners', () => {
  const tempRoot = resolve(import.meta.dir, '../../../../.temp');
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, 'replay-discovery-'));
  try {
    const routes = join(directory, 'services/main/src/routes');
    mkdirSync(routes, { recursive: true });
    writeFileSync(join(routes, 'contract.ts'), `
      const policy = { exposure: 'public', idempotencyKey: true } as const;
      export const operation = { method: 'put', path: '/v1/contract', policy } as const;
      export const privatePolicy = { exposure: 'platform:operators' } as const;
    `);
    writeFileSync(join(routes, 'example.ts'), `
      import { operation, privatePolicy } from './contract.ts';
      export const openApiOperations = {
        '/v1/saved': { post: { exposure: 'public', idempotencyKey: true } },
        '/v1/repeated': { put: { exposure: 'public' } },
        '/v1/factory': { post: { exposure: 'public', idempotencyKey: true } },
        '/v1/private': { post: { exposure: 'platform:operators' } },
        '/v1/contract': { put: operation.policy },
        '/v1/private-contract': { put: privatePolicy },
      };
      class Owner { saved() { return { replayed: true }; } repeated() { return { executed: true }; } }
      const owner = new Owner();
      const app = { post: (_path: string, handler: () => unknown) => handler, put: (_path: string, handler: () => unknown) => handler };
      app.post('/v1/saved', () => owner.saved());
      app.put('/v1/repeated', () => owner.repeated());
      const handler = (callback: () => unknown) => callback;
      app.post('/v1/factory', handler(() => owner.saved()));
      app.post('/v1/private', () => owner.saved());
      const makeHandler = (owner: Owner) => () => owner.saved();
      app[operation.method](operation.path, makeHandler(owner));
      app.put('/v1/private-contract', makeHandler(owner));
    `);
    const inventory = discoverPublicCommands(directory);
    expect(inventory.map(row => row.operation)).toEqual(['POST /v1/saved', 'PUT /v1/repeated', 'POST /v1/factory', 'PUT /v1/contract']);
    expect(inventory[0]!.idempotencyKey).toBe(true);
    expect(inventory[0]!.paths).toHaveLength(1);
    expect(inventory[1]!.idempotencyKey).toBe(false);
    expect(inventory[1]!.paths).toEqual([]);
    expect(inventory[1]!.reachableOwners).toContain('routes/example.ts#Owner.repeated');
    expect(inventory[2]!.reachableOwners).toContain('routes/example.ts#Owner.saved');
    expect(inventory[2]!.paths).toEqual([]);
    expect(inventory[3]!.idempotencyKey).toBe(true);
    expect(inventory[3]!.paths).toHaveLength(1);
    expect(inventory[3]!.reachableOwners).toContain('routes/example.ts#Owner.saved');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
