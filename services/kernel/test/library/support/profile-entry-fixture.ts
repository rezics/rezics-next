import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { releaseDigest, type Release } from '@rezics/definitions';
import { compileCatalogue } from '@rezics/definitions/compile';
import {
  fixture,
  compiledProfile,
  libraryLabels,
  libraryProfile,
  legacyProfile,
  profileOf,
  unitData,
  type ProfileData,
} from '../../../../../packages/definitions/test/support/library-profiles.ts';
import { bootstrapGovernance } from '../../../src/access/bootstrap-governance.ts';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import { createLifecycleInternals, type ProvisioningEvidence } from '../../../src/access/lifecycle.ts';
import { createSuspensionCommands } from '../../../src/access/suspension.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import type { KernelClock } from '../../../src/clock.ts';
import { createPool } from '../../../src/database/pool.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { createEntryCommands } from '../../../src/library/entries.ts';
import type { Access, AccountActor, Resource } from '../../../src/request/access.ts';
import { deadlineFor } from '../../../src/request/deadline.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { linkProjection } from '../../../src/semantic/links.ts';
import { accountToken, admittedAccess, authenticateAccount } from '../../support/admitted-access.ts';
import { testRouteKey, testTokens } from '../../support/test-kernel.ts';
import {
  createProfileHistoricalNativeFixture,
  createProfileReceiptObservations,
} from './profile-historical-native-fixture.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';

export type ProfileVertical = 'game' | 'recipe' | 'record' | 'unprofiled';
export const entryTypes = { game: 'ex:Child', recipe: 'ex:Recipe', record: 'ex:Record', unprofiled: 'ex:Person' };
export const entryStates = { game: 'playing', recipe: 'cooking', record: 'listening' };
export const entryKey = () => randomUUID();
const global = { route: 0, id: GLOBAL_CONTEXT };
const clientId = 'native-profile-entry';
const entryScopes = [
  'subject:create',
  'subject:read',
  'library_entry:read',
  'library_entry:list',
  'library_entry:update',
  'library_entry:delete',
  'follow:read',
  'follow:create',
  'follow:delete',
];

/** Data-only compatibility vocabulary for the original Library outcome journeys.
 * Book and edition still enter through Semantic, with real compiled accepting profiles.
 */
export async function compileLibraryOutcomeRelease(): Promise<Release> {
  const input = bundledSources();
  const book = Bun.YAML.parse(input.schemas['book.yaml']!) as {
    classes: Record<'Work' | 'Edition', { annotations: { library: ProfileData } }>;
  };
  const profiles = [book.classes.Work.annotations.library, book.classes.Edition.annotations.library];
  for (const profile of profiles) {
    // The old outcomes exercise every original mode/unit, plus independent lending.
    // Declare those choices in compiler input rather than defaulting arbitrary requests.
    profile.progress = legacyProfile().progress;
    profile.copies.kinds = [
      { id: 'physical', statuses: ['ordered', 'owned', 'lent', 'disposed'].map((id) => ({ id })) },
      { id: 'digital', statuses: [{ id: 'owned' }] },
    ];
  }
  input.schemas['book.yaml'] = Bun.YAML.stringify(book);
  for (const [path, source] of Object.entries(input.presentation)) {
    if (!path.startsWith('book/')) continue;
    const labels = Bun.YAML.parse(source) as { libraryProfiles: Record<string, ProfileData> };
    const locale = path.slice('book/'.length) as Parameters<typeof libraryLabels>[1];
    for (const profile of profiles) labels.libraryProfiles[profile.id] = libraryLabels(profile, locale);
    input.presentation[path] = Bun.YAML.stringify(labels);
  }
  return compileCatalogue(input);
}

/** Real compiler output, including a child whose structural bases are not primary types. */
export async function compileEntryRelease(
  version: 'original' | 'replacement',
  gameUnits?: readonly string[],
): Promise<Release> {
  const profiles = Object.fromEntries(
    Object.entries(entryStates).map(([vertical, state]) => {
      const profile = libraryProfile(`fixture.${vertical}`, vertical === 'record' ? 'track' : 'minute');
      profile.entryStateSet.states.push({ id: version === 'replacement' ? `${state}_again` : state, role: 'active' });
      return [vertical, profile];
    }),
  ) as Record<'game' | 'recipe' | 'record', ProfileData>;
  const input = fixture(profiles.game);
  const schema = JSON.parse(input.schemas['fixture.yaml']!);
  schema.version = version;
  // Collection API fixtures select from the bundled vocabulary. Keep that Type in
  // the actual compiled/activated fixture release, alongside the profile test Types.
  const presentationType = Object.keys(bundledRelease.types).sort()[0]!;
  const prefix = presentationType.split(':')[0]!;
  schema.prefixes[prefix] = bundledRelease.prefixes[prefix];
  schema.classes.CollectionPresentation = { class_uri: presentationType };
  schema.classes.Recipe = { class_uri: 'ex:Recipe', annotations: { library: profiles.recipe } };
  schema.classes.Record = {
    class_uri: 'ex:Record',
    ...(version === 'original' ? { annotations: { library: profiles.record } } : {}),
  };
  input.schemas['fixture.yaml'] = JSON.stringify(schema);
  for (const [key, text] of Object.entries(input.presentation)) {
    const labels = JSON.parse(text);
    const locale = key.split('/')[1] as Parameters<typeof libraryLabels>[1];
    Object.assign(labels.types, {
      'ex:Recipe': 'recipe',
      'ex:Record': 'record',
      [presentationType]: 'presentation selection',
    });
    for (const profile of [profiles.recipe, ...(version === 'original' ? [profiles.record] : [])])
      labels.libraryProfiles[profile.id] = libraryLabels(profile, locale);
    input.presentation[key] = JSON.stringify(labels);
  }
  const release = compileCatalogue(input);
  const game = gameUnits ? profileOf(release, 'ex:Parent') : null;
  if (game) {
    game.progress.allowed[0].units = gameUnits!.map((unit) => unitData(unit));
    Object.assign(game, compiledProfile(game));
  }
  return release;
}

export type NativeProfileFixture = Awaited<ReturnType<typeof createProfileEntryFixture>>;

/** No server, remote driver, policy map or raw account/subject/grant inserts. */
export async function createProfileEntryFixture(
  options: {
    clock?: KernelClock;
    pool?: Pool;
    singleConnection?: boolean;
    projectLinks?: boolean;
    gameUnits?: readonly string[];
  } = {},
) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = options.pool ?? createPool(url);
  if (options.singleConnection) pool.options.max = 1;
  // Assertions cannot observe an uncommitted writer connection or mutate the fixture.
  const reader = new pg.Pool({ connectionString: url, max: 1, options: '-c default_transaction_read_only=on' });
  try {
    const tokens = testTokens();
    const routeKey = testRouteKey();
    let access!: Access;
    const kernel = createKernel({
      pool,
      tokens,
      routeKey,
      receiptKeys: testReceiptKeys(),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      requestDeadlineMs: 30_000,
      access(config) {
        return (access = admittedAccess(config));
      },
      writeRate: createWriteRateLimiter({
        secret: 'native-profile-entry-test-rate-secret',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
      }),
    });
    // The kernel composes Access lazily from its complete mounted action catalogue.
    // Resolve it through an ordinary public read before authenticating native actors.
    const warm = await kernel.handle(new Request('http://kernel.test/v1/definitions/active'));
    expect([200, 404]).toContain(warm.status);
    expect(access).toBeDefined();
    const projection = linkProjection(pool);
    const partitions = new Set([0]);
    // Run the real relay for scenarios that consume Semantic link projections.
    // Direct source-reference scenarios can leave this unrelated worker asynchronous.
    async function drainSubjectLinks() {
      if (options.projectLinks === false) return;
      for (let step = 0; step < 20; step++) {
        let pending = false;
        for (const partition of partitions) {
          const result = await projection.run(partition);
          pending ||= result.status === 'busy' || result.envelopes > 0;
        }
        if (!pending) return;
      }
      throw new Error('Native Semantic link projection did not drain');
    }
    const commands = createEntryCommands({ pool, access, tokens, ...options });
    const context = (actor: AccountActor) => ({ pool, actor, deadline: deadlineFor(30_000) });

    // This trusted adapter establishes test identities at the documented native provisioning
    // boundary only. It cannot authorize an end-user command, grant or Semantic create.
    const proofs = new WeakMap<object, ProvisioningEvidence>();
    const lifecycle = createLifecycleInternals({
      pool,
      routeKey,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      provisioningEvidence: async (proof) =>
        typeof proof === 'object' && proof !== null ? (proofs.get(proof) ?? null) : null,
      recoveryEvidence: async () => null,
    });
    async function identity(scopes: readonly string[], partition?: number, exactRoute?: number) {
      if (partition !== undefined && (!Number.isInteger(partition) || partition < 0 || partition >= 4096))
        throw new RangeError('Identity partition must be between 0 and 4095');
      if (
        exactRoute !== undefined &&
        (!Number.isInteger(exactRoute) ||
          exactRoute < 0 ||
          exactRoute >= 65536 ||
          (partition !== undefined && partitionOf(exactRoute) !== partition))
      )
        throw new RangeError('Identity route must be between 0 and 65535 and in the requested partition');
      // Select the registration request key, never forge or rewrite the producer's account ID.
      let key = entryKey();
      let accountId = lifecycle.registrationTarget(key);
      while (
        (partition !== undefined && partitionOf(routeOf(accountId)!) !== partition) ||
        (exactRoute !== undefined && routeOf(accountId) !== exactRoute)
      ) {
        key = entryKey();
        accountId = lifecycle.registrationTarget(key);
      }
      partitions.add(partitionOf(routeOf(accountId)!));
      const handle = `profile_${key.replaceAll('-', '')}`;
      const reservation = await lifecycle.reserveHandle({ accountId, handle, key });
      const input = { accountId, handle, reservationId: reservation.value.reservationId, key };
      const pending = await lifecycle.createPending(input);
      const proof = Object.freeze({});
      proofs.set(proof, {
        accountId,
        registrationId: pending.value.registrationId,
        authIdentityId: accountId,
        authnEpoch: 1,
      });
      await lifecycle.claimHandle({ ...input, key: entryKey(), evidence: proof });
      await lifecycle.activate({ accountId, key: entryKey(), evidence: proof });
      const claims = { accountId, clientId, scopes };
      // Native growth setup reuses this genuine five-minute test credential across requests.
      // Each native command still supplies and enforces its own physical operation deadline.
      const actor = await authenticateAccount(access, { pool, deadline: deadlineFor(300_000) }, claims);
      return { actor, bearer: await accountToken(claims) };
    }
    const steward = await identity([
      'access:grant',
      'offer:create',
      'subject:create',
      'statement:propose',
      'definitions:read',
      'definitions:publish',
      'definitions:activate',
      'account:suspend',
      'moderation:hide',
      'subject:read',
      'exposure:open',
      'exposure:close',
      'gate:any',
    ]);
    const owner = await identity(entryScopes);
    const other = await identity(entryScopes);
    await bootstrapGovernance(pool, steward.actor.accountId);
    const grants = createGrantCommands({ pool, access, managementAction: 'access:grant', ...options });
    const grant = (resource: Resource, subject: string, actions: string[]) =>
      grants.create(context(steward.actor), {
        resource,
        subject: { kind: 'account', id: subject },
        actions,
        valid: '(,)',
        key: entryKey(),
      });
    await grant(global, steward.actor.accountId, ['definitions:publish', 'definitions:activate']);
    // Governance bootstrap already performed the Global parent's one-time installation.
    // Extend its standing creation authority through ordinary, fully authorized grants.
    await grants.create(context(steward.actor), {
      resource: global,
      subject: { kind: 'active_accounts' },
      actions: ['subject:create', 'statement:propose'],
      valid: '(,)',
      key: entryKey(),
    });

    async function sendWithHeaders(
      persona: 'owner' | 'other' | 'steward' | 'anonymous' | string,
      method: string,
      path: string,
      body?: unknown,
      extraHeaders: HeadersInit = {},
    ) {
      await drainSubjectLinks();
      const bearer =
        persona === 'owner'
          ? owner.bearer
          : persona === 'other'
            ? other.bearer
            : persona === 'steward'
              ? steward.bearer
              : persona === 'anonymous'
                ? null
                : persona;
      const headers = new Headers(extraHeaders);
      if (bearer) headers.set('authorization', `Bearer ${bearer}`);
      if (!headers.has('idempotency-key')) headers.set('idempotency-key', JSON.stringify(entryKey()));
      if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
      return kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    }
    async function send(
      persona: 'owner' | 'other' | 'steward' | 'anonymous' | string,
      method: string,
      path: string,
      body?: unknown,
      key: string = entryKey(),
    ) {
      return sendWithHeaders(persona, method, path, body, { 'idempotency-key': JSON.stringify(key) });
    }
    async function readHead(): Promise<{ digest: string; head: number } | null> {
      const response = await send('anonymous', 'GET', '/v1/definitions/active');
      if (response.status === 404) return null;
      expect(response.status).toBe(200);
      return response.json();
    }
    async function setLibraryOpen(open: boolean) {
      const response = await send(
        'steward',
        'POST',
        `/v1/platform/exposure/personal_library:${open ? 'open' : 'close'}`,
      );
      expect(response.status).toBe(200);
    }
    async function publish(release: Release) {
      const before = await readHead();
      const digest = releaseDigest(release);
      const response = await send('steward', 'POST', '/v1/definitions/releases', { release });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ digest });
      expect(await readHead()).toEqual(before);
      const read = await send('anonymous', 'GET', `/v1/definitions/releases/${digest}`);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ digest, release });
      return digest;
    }
    async function activate(digest: string) {
      const before = await readHead();
      const response = await send('steward', 'POST', `/v1/definitions/releases/${digest}:activate`, {
        expected_head: before?.head ?? null,
      });
      expect(response.status).toBe(200);
      const active = await readHead();
      expect(active?.digest).toBe(digest);
      return active!;
    }
    async function createSubject(vertical: ProfileVertical, label: string = vertical) {
      const response = await send('owner', 'POST', '/v1/subjects', {
        type: entryTypes[vertical],
        labels: { en: label },
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { subject: { id: string; type: string } };
      expect(body.subject.type).toBe(entryTypes[vertical]);
      partitions.add(partitionOf(routeOf(body.subject.id)!));
      await drainSubjectLinks();
      return body.subject.id;
    }
    async function inspect(accountId = owner.actor.accountId) {
      const client = await reader.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const rows = async (sql: string, parameters: unknown[] = [routeOf(accountId), accountId]) =>
          (await client.query(sql, parameters)).rows;
        const result = {
          entries: await rows(
            'SELECT to_jsonb(f) AS row FROM library.entry f WHERE route=$1 AND account_id=$2 ORDER BY subject_id',
          ),
          deletedEntries: await rows(
            'SELECT to_jsonb(f) AS row FROM library.entry_deleted f WHERE route=$1 AND account_id=$2 ORDER BY deletion_id',
          ),
          ownerCounter: await rows(
            'SELECT to_jsonb(f) AS row FROM library.owner_write_counter f WHERE route=$1 AND account_id=$2',
          ),
          factSourceHead: await rows(
            'SELECT to_jsonb(f) AS row FROM library.fact_source_head f WHERE route=$1 AND account_id=$2',
          ),
          sessions: await rows(
            'SELECT to_jsonb(f) AS row FROM library.progress_session f WHERE route=$1 AND account_id=$2 ORDER BY session_id',
          ),
          copies: await rows(
            'SELECT to_jsonb(f) AS row FROM library.copy f WHERE route=$1 AND account_id=$2 ORDER BY copy_id',
          ),
          entitlements: await rows(
            'SELECT to_jsonb(f) AS row FROM commerce.entitlement f WHERE route=$1 AND account_id=$2 ORDER BY entitlement_id',
          ),
          follows: await rows(
            'SELECT to_jsonb(f) AS row FROM library.follow f WHERE route=$1 AND account_id=$2 ORDER BY target_id',
          ),
          receipts: await rows(
            'SELECT to_jsonb(f) AS row FROM core.receipt f WHERE partition_no=$1 AND principal_id=$2 ORDER BY command_kind,idempotency_key',
            [partitionOf(routeOf(accountId)!), accountId],
          ),
          events: await rows(
            'SELECT to_jsonb(f) AS row FROM core.outbox f WHERE partition_no=$1 AND subject=$2 ORDER BY position,event_seq',
            [partitionOf(routeOf(accountId)!), accountId],
          ),
          partition: await rows('SELECT to_jsonb(p) AS row FROM core.partition p WHERE partition_no=$1', [
            partitionOf(routeOf(accountId)!),
          ]),
        };
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    const original = await compileEntryRelease('original', options.gameUnits);
    const replacement = await compileEntryRelease('replacement', options.gameUnits);
    const originalDigest = await publish(original);
    const replacementDigest = await publish(replacement);
    await activate(originalDigest);
    await setLibraryOpen(true);
    // A native, authorized baseline must finish before any expected missing profile behavior.
    const baseline = await createSubject('game');
    const accepted = await commands.putEntry(owner.actor, baseline, { state: 'planned' }, entryKey());
    expect(accepted.value.entry.subjectId).toBe(baseline);
    expect((await commands.readEntry(owner.actor, baseline)).state).toBe('planned');
    expect((await send('owner', 'GET', `/v1/libraryEntries/${baseline}`)).status).toBe(200);

    return {
      pool,
      access,
      tokens,
      commands,
      owner,
      other,
      steward,
      original,
      replacement,
      originalDigest,
      replacementDigest,
      identity,
      send,
      sendWithHeaders,
      createSubject,
      publish,
      activate,
      readHead,
      inspect,
      async historical(identity: { actor: AccountActor; bearer: string }) {
        const open = await send('steward', 'POST', '/v1/platform/exposure/reading_progress:open');
        expect(open.status).toBe(200);
        const receipts = createProfileReceiptObservations(pool);
        return {
          receipts,
          ...createProfileHistoricalNativeFixture({
            pool,
            actor: identity.actor,
            ...(options.clock === undefined ? {} : { clock: options.clock }),
            createSubject: () => createSubject('game'),
            send: (method, path, body, key) => send(identity.bearer, method, path, body, key),
            receipts,
          }),
        };
      },
      setLibraryOpen,
      async grantLibraryGate(accountId: string) {
        await grant(global, accountId, ['gate:personal_library']);
      },
      async revokeLibraryGate(accountId: string) {
        await grants.revoke(context(steward.actor), {
          resource: global,
          subject: { kind: 'account', id: accountId },
          actions: ['gate:personal_library'],
          valid: '(,)',
          key: entryKey(),
        });
      },
      unknownSubject: () => newId(0x6e31),
      async suspend(accountId: string) {
        await createSuspensionCommands({ pool, access, clock: options.clock ?? (() => new Date()) }).suspend(
          context(steward.actor),
          {
            accountId,
            key: entryKey(),
          },
        );
      },
      async revokeIdentity(accountId: string) {
        await lifecycle.raiseFence({ accountId, key: entryKey() });
      },
      async close() {
        await Promise.all([...(options.pool ? [] : [pool.end()]), reader.end()]);
      },
    };
  } catch (error) {
    await Promise.all([...(options.pool ? [] : [pool.end()]), reader.end()]);
    throw error;
  }
}
