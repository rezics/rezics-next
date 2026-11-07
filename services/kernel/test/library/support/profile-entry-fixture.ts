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
  registryOf,
  unitData,
  type ProfileData,
} from '../../../../../packages/definitions/test/support/library-profiles.ts';
import {
  bootstrapGovernance,
  PLATFORM_GOVERNANCE_ROLE,
  PLATFORM_RESOURCE,
} from '../../../src/access/bootstrap-governance.ts';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import { createLifecycleInternals, type ProvisioningEvidence } from '../../../src/access/lifecycle.ts';
import { resourceRoleCatalogue } from '../../../src/access/resource-roles.ts';
import { createSuspensionCommands } from '../../../src/access/suspension.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { systemClock, type KernelClock } from '../../../src/clock.ts';
import { composeLibraryDomain } from '../../../src/composition/library.ts';
import { createPool } from '../../../src/database/pool.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { runCommand } from '../../../src/command/command.ts';
import { createEntryCommands } from '../../../src/library/entries.ts';
import { stepLibraryIdentityEpoch } from '../../../src/library/identity-epoch-participant.ts';
import { accessCheck } from '../../../src/request/access-check.ts';
import { type Access, type AccountActor } from '../../../src/request/access.ts';
import { deadlineFor } from '../../../src/request/deadline.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { linkProjection } from '../../../src/semantic/links.ts';
import {
  identityEpochStore,
  identityJobPartition,
  IdentityEpochStoreError,
} from '../../../src/semantic/identity-adapters/index.ts';
import { stepIdentityEpochAdmission } from '../../../src/semantic/identity-epoch-admission.ts';
import { installIdentityEpochBootstrap } from '../../../src/semantic/identity-epoch-bootstrap-install.ts';
import { stepIdentityEpochBootstrap } from '../../../src/semantic/identity-epoch-bootstrap.ts';
import {
  resumeIdentityEpochJob,
  waitIdentityEpochPublished,
} from '../../../src/semantic/identity-epoch-coordinator.ts';
import type { IdentityJobRef } from '../../../src/semantic/identity-epoch-contract.ts';
import { stepIdentityEpochMapping } from '../../../src/semantic/identity-epoch-mapping.ts';
import { subjectTarget } from '../../../src/semantic/subject.ts';
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
const global = { route: PLATFORM_RESOURCE.route, id: PLATFORM_RESOURCE.id };
const clientId = 'native-profile-entry';
const entryScopes = [
  'subject:create',
  'subject:read',
  'library_entry:read',
  'library_entry:list',
  'library_entry:update',
  'library_entry:delete',
  'progress_session:create',
  'progress_session:list',
  'progress_session:read',
  'progress_session:update',
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
  const release = await compileCatalogue(input);
  const game = gameUnits ? registryOf(release)?.['fixture.game'] : null;
  if (gameUnits && !game) throw new Error('Fixture release is missing the game profile registry entry');
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
    databaseUrl?: string;
    singleConnection?: boolean;
    projectLinks?: boolean;
    gameUnits?: readonly string[];
    ownerScopes?: readonly string[];
  } = {},
) {
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
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
      onAccessReady(access) {
        composeLibraryDomain({ pool, access, routeKey, clock: options.clock ?? systemClock });
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
    const mappedHomes = new Set<number>();
    let identityHomesReady = false;
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
    function isIdentityPrearmHold(error: unknown) {
      if (!(error instanceof Error)) return false;
      const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
      return (
        error.message.includes('identity_epoch_unavailable') ||
        code === 'identity_epoch_unavailable' ||
        (code === 'P0001' && error.message.includes('identity_epoch'))
      );
    }
    async function identityDirty(home: number, original?: string) {
      return original
        ? (
            await pool.query(
              `SELECT 1 FROM semantic.identity_epoch_dirty
                WHERE route=$1 AND original=$2 AND revision>captured_revision LIMIT 1`,
              [routeOf(original), original],
            )
          ).rowCount
        : (
            await pool.query(
              `SELECT 1 FROM semantic.identity_epoch_dirty
                WHERE route BETWEEN $1 AND $2 AND revision>captured_revision LIMIT 1`,
              [home * 16, home * 16 + 15],
            )
          ).rowCount;
    }
    async function heldPrearmJobs(home: number): Promise<IdentityJobRef[]> {
      const pins = (
        await pool.query<{ job_id: string }>(
          `SELECT DISTINCT job_id::text AS job_id FROM (
             SELECT job_id FROM semantic.identity_epoch_prearm_bridge
              WHERE partition_no=$1 AND job_id IS NOT NULL
             UNION ALL
             SELECT pending_job FROM semantic.identity_epoch_group
              WHERE partition_no=$1 AND pending_job IS NOT NULL
             UNION ALL
             SELECT pending_job FROM semantic.identity_epoch_control
              WHERE partition_no=$1 AND pending_job IS NOT NULL
             UNION ALL
             SELECT prepare_job FROM semantic.identity_epoch_control
              WHERE partition_no=$1 AND prepare_job IS NOT NULL
             UNION ALL
             SELECT pending_job FROM semantic.identity_epoch_home_gate
              WHERE route BETWEEN $2 AND $3 AND pending_job IS NOT NULL
             UNION ALL
             SELECT job_id FROM semantic.identity_epoch_job
              WHERE partition_no=$1 AND state NOT IN ('published','cancelled')
           ) pins(job_id)
           WHERE job_id IS NOT NULL`,
          [home, home * 16, home * 16 + 15],
        )
      ).rows;
      const jobs: IdentityJobRef[] = [];
      for (const pin of pins) {
        const saved = (
          await pool.query<{ epoch: string }>(
            `SELECT epoch::text AS epoch FROM semantic.identity_epoch_job
              WHERE job_id=$1::uuid ORDER BY epoch DESC LIMIT 1`,
            [pin.job_id],
          )
        ).rows[0];
        jobs.push({ jobId: pin.job_id, epoch: saved ? BigInt(saved.epoch) : 0n });
      }
      return jobs;
    }
    async function homeCapacityOccupied(home: number) {
      const control = (
        await pool.query<{ pending_job: string | null; prepare_job: string | null }>(
          `SELECT pending_job::text AS pending_job, prepare_job::text AS prepare_job
             FROM semantic.identity_epoch_control WHERE partition_no=$1`,
          [home],
        )
      ).rows[0];
      return Boolean(control?.pending_job || control?.prepare_job || (await heldPrearmJobs(home)).length);
    }
    async function catchUpIdentity(home: number) {
      const drained = new Set<string>();
      const keyOf = (job: IdentityJobRef) => `${job.jobId}:${job.epoch.toString()}`;
      for (let n = 0; n < 1000; n++) {
        // Birth mappings and already-installed epochs stay current. Another bootstrap
        // generation would rewrite published_epoch and invalidate reviewed identity.
        if (!(await identityDirty(home)) && !(await homeCapacityOccupied(home))) return;
        const held = await heldPrearmJobs(home);
        for (const job of held) {
          if (drained.has(keyOf(job))) continue;
          await drainIdentityJob(job);
          drained.add(keyOf(job));
        }
        if (!(await identityDirty(home)) && !(await homeCapacityOccupied(home))) return;
        try {
          const progress = await stepIdentityEpochBootstrap(pool, home);
          if (progress.state === 'caught-up' && !(await identityDirty(home)) && !(await homeCapacityOccupied(home)))
            return;
        } catch (error) {
          if (!isIdentityPrearmHold(error)) throw error;
          const retry = await heldPrearmJobs(home);
          if (retry.length) {
            for (const job of retry) {
              if (drained.has(keyOf(job))) continue;
              await drainIdentityJob(job);
              drained.add(keyOf(job));
            }
            continue;
          }
          if (!(await identityDirty(home)) && !(await homeCapacityOccupied(home))) return;
        }
      }
      throw new Error('Native identity bootstrap did not finish');
    }
    async function recaptureMappedHomes() {
      for (const home of mappedHomes) await catchUpIdentity(home);
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
        routeOf(accountId) === 0 ||
        (partition !== undefined && partitionOf(routeOf(accountId)!) !== partition) ||
        (exactRoute !== undefined && routeOf(accountId) !== exactRoute)
      ) {
        key = entryKey();
        accountId = lifecycle.registrationTarget(key);
      }
      const home = partitionOf(routeOf(accountId)!);
      partitions.add(home);
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
      // Use wall time, not deadlineFor: a leaked request ALS deadline is the kernel's 30s budget.
      const actor = await authenticateAccount(access, { pool, deadline: Date.now() + 300_000 }, claims);
      // Partition 0 is the Global question/control home. Sealing it before the first
      // Subject exists leaves later creations past the bootstrap cursor with captured
      // dirty, so catch it up only after createHomeSubject/admitSubjectMerge.
      if (identityHomesReady && (home !== 0 || mappedHomes.has(0))) await catchUpIdentity(home);
      return { actor, bearer: await accountToken(claims) };
    }
    // Grant-routes and outcome-driver admit platform.governance only on a token
    // that carries the complete mounted catalogue plus gate:any. A reduced sibling
    // list is denied even when the role row exists. media:complete stays off the
    // token; it is reserved to the confidential website client.
    const steward = await identity([
      ...new Set([...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete').concat('gate:any')),
    ]);
    const owner = await identity([...entryScopes, ...(options.ownerScopes ?? [])], 0);
    const other = await identity(entryScopes, 0);
    await bootstrapGovernance(pool, steward.actor.accountId);
    // platform.governance is the first Global holder. Ordinary grant commands then
    // create the steward's definition and library grants; no test-only grant rows.
    // Grant-routes authenticates that original bearer onto a fresh command boundary
    // and records the live account/resource/role binding. gate:any on those original
    // scopes covers library-gate delegation; a minted sibling token does not.
    const grants = createGrantCommands({
      pool,
      access,
      managementAction: 'access:grant',
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const grantReceiptKeys = new Map<string, string>();
    const grantIntent = (
      operation: 'create' | 'revoke',
      subject: { kind: 'account'; id: string } | { kind: 'active_accounts' },
      actions: readonly string[],
    ) => JSON.stringify([operation, subject, [...actions].sort(), '(,)']);
    function grantReceiptKey(
      operation: 'create' | 'revoke',
      subject: { kind: 'account'; id: string } | { kind: 'active_accounts' },
      actions: readonly string[],
    ) {
      const intent = grantIntent(operation, subject, actions);
      let key = grantReceiptKeys.get(intent);
      if (!key) grantReceiptKeys.set(intent, (key = entryKey()));
      return key;
    }
    async function grantFacts(
      actor: AccountActor,
      granted: readonly string[],
      boundary: { pool: typeof pool; deadline: number },
    ) {
      const roles = await reader.query(
        `SELECT grant_role AS fact, subject_kind, subject_id::text AS subject
           FROM access.resource_role_grant
          WHERE route = 0 AND resource_id = $1 AND subject_id = $2
          ORDER BY grant_role`,
        [global.id, steward.actor.accountId],
      );
      const held = await reader.query(
        `SELECT action AS fact, subject_kind, subject_id::text AS subject
           FROM access.resource_grant
          WHERE route = 0 AND resource_id = $1 AND (subject_id = $2 OR subject_kind = 'active_accounts')
          ORDER BY action, subject_kind, subject`,
        [global.id, steward.actor.accountId],
      );
      const account = await reader.query(
        `SELECT kind, state, authn_fenced AS fenced, membership_inverse_complete AS complete
           FROM access.account WHERE route = $1 AND account_id = $2`,
        [routeOf(steward.actor.accountId), steward.actor.accountId],
      );
      const roleActions = [...(resourceRoleCatalogue(access)?.roles.get(PLATFORM_GOVERNANCE_ROLE) ?? [])];
      const needed = ['access:grant', 'gate:any', ...granted];
      const permitted: Record<string, boolean | string> = {};
      for (const action of needed) {
        try {
          permitted[action] = await (await accessCheck(access, actor, action, global, boundary))(pool);
        } catch (error) {
          permitted[action] = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        role: PLATFORM_GOVERNANCE_ROLE,
        roleActions,
        roles: roles.rows,
        grants: held.rows,
        account: account.rows[0] ?? null,
        actor: { accountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        bound: actor.accountId === steward.actor.accountId && actor.clientId === steward.actor.clientId,
        resource: global,
        requested: granted,
        deadline: boundary.deadline,
        scopes: actor.scopes.length,
        tokenScopes: needed.filter((action) => actor.scopes.includes(action)),
        missingFromToken: needed.filter((action) => !actor.scopes.includes(action)),
        missingFromRole: needed.filter((action) => !roleActions.includes(action)),
        permitted,
      };
    }
    async function grantOnDeadline(
      subject: { kind: 'account'; id: string } | { kind: 'active_accounts' },
      actions: readonly string[],
      revoke = false,
    ) {
      // grant-routes authenticates the original steward bearer onto a fresh wall-clock
      // boundary, then spreads that same object into the command. deadlineFor can
      // reuse a leaked request ALS deadline; a minted sibling token drops coverage.
      const boundary = { pool, deadline: Date.now() + 10_000 };
      const actor = await access.authenticate(steward.bearer, boundary);
      let requestedActions = [...new Set(actions)].sort();
      if (!revoke && subject.kind === 'account' && subject.id === actor.accountId) {
        const held = await Promise.all(
          requestedActions.map(async (action) => (await accessCheck(access, actor, action, global, boundary))(pool)),
        );
        requestedActions = requestedActions.filter((_, index) => !held[index]);
      }
      if (!revoke && requestedActions.length === 0) return;
      const input = {
        resource: global,
        subject,
        actions: requestedActions,
        valid: '(,)',
        key: grantReceiptKey(revoke ? 'revoke' : 'create', subject, requestedActions),
      };
      const command = { ...boundary, actor };
      try {
        if (revoke) await grants.revoke(command, input);
        else await grants.create(command, input);
        grantReceiptKeys.delete(grantIntent(revoke ? 'create' : 'revoke', subject, requestedActions));
      } catch (error) {
        throw new Error(
          `Grant ${revoke ? 'revoke' : 'create'} denied: ${error instanceof Error ? error.message : String(error)} facts=${JSON.stringify(await grantFacts(actor, actions, boundary))}`,
          { cause: error },
        );
      }
    }
    await grantOnDeadline({ kind: 'account', id: steward.actor.accountId }, [
      'definitions:publish',
      'definitions:activate',
      'subject:merge',
      'gate:personal_library',
    ]);
    // Governance bootstrap already performed the Global parent's one-time installation.
    // Extend its standing creation authority through ordinary, fully authorized grants.
    await grantOnDeadline({ kind: 'active_accounts' }, ['subject:create', 'statement:propose']);
    await installIdentityEpochBootstrap(pool);
    identityHomesReady = true;
    for (const home of partitions) {
      if (home === 0) continue;
      await catchUpIdentity(home);
    }
    const grantAccountActions = (accountId: string, actions: readonly string[]) =>
      grantOnDeadline({ kind: 'account', id: accountId }, actions);

    async function sendWithHeaders(
      persona: 'owner' | 'other' | 'steward' | 'anonymous' | string,
      method: string,
      path: string,
      body?: unknown,
      extraHeaders: HeadersInit = {},
    ) {
      await drainSubjectLinks();
      await recaptureMappedHomes();
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
    async function drainIdentityJob(job: IdentityJobRef) {
      const saved = (
        await pool.query<{ state: string; epoch: string; partition_no: number }>(
          `SELECT state, epoch::text AS epoch, partition_no
             FROM semantic.identity_epoch_job WHERE job_id=$1::uuid ORDER BY epoch DESC LIMIT 1`,
          [job.jobId],
        )
      ).rows[0];
      const resolved: IdentityJobRef = saved ? { jobId: job.jobId, epoch: BigInt(saved.epoch) } : job;
      if (!saved || saved.state === 'published' || saved.state === 'cancelled') return;
      let admitted = saved.state === 'pending';
      if (!admitted) {
        for (let attempt = 0; attempt < 16; attempt++) {
          const progress = await stepIdentityEpochAdmission(pool, resolved);
          if (progress.state === 'pending' || progress.state === 'published') {
            admitted = true;
            break;
          }
          expect(progress.state).toBe('preparing');
        }
        expect(admitted).toBe(true);
      }
      let mapped = false;
      for (let attempt = 0; attempt < 512; attempt++) {
        const progress = await stepIdentityEpochMapping(pool, resolved);
        if (progress.state === 'complete') {
          mapped = true;
          break;
        }
      }
      if (!mapped) throw new Error('Native identity mapping did not finish');
      const store = identityEpochStore();
      const partition = identityJobPartition(resolved);
      for (let attempt = 0; attempt < 32; attempt++) {
        try {
          if ((await stepLibraryIdentityEpoch(pool, resolved)).state === 'complete') break;
        } catch (error) {
          if (!(error instanceof IdentityEpochStoreError)) throw error;
          break;
        }
      }
      try {
        await resumeIdentityEpochJob(pool, resolved);
        await waitIdentityEpochPublished(pool, resolved);
        return;
      } catch (error) {
        if (!(error instanceof IdentityEpochStoreError)) throw error;
      }
      try {
        await runCommand(pool, { partition }, (tx) => store.publish(tx, resolved));
      } catch (error) {
        if (!(error instanceof IdentityEpochStoreError) || error.code !== 'identity_participants_incomplete')
          throw error;
      }
    }
    async function drainIdentityMerge(jobId: string) {
      const found = (
        await pool.query<{ epoch: string }>(
          'SELECT epoch::text AS epoch FROM semantic.identity_epoch_job WHERE job_id=$1::uuid ORDER BY epoch DESC LIMIT 1',
          [jobId],
        )
      ).rows[0];
      if (!found) throw new Error('Native merge identity job was not retained');
      await drainIdentityJob({ jobId, epoch: BigInt(found.epoch) });
    }
    async function awaitCurrentIdentity(subjectId: string) {
      const home = partitionOf(routeOf(subjectId)!);
      partitions.add(home);
      mappedHomes.add(home);
      for (let attempt = 0; attempt < 64; attempt++) {
        await catchUpIdentity(home);
        const mapping = await identityEpochStore().readMapping(pool, subjectId);
        const occupied = await homeCapacityOccupied(home);
        if (mapping.state === 'mapped' && !(await identityDirty(home)) && !occupied) return;
        if (mapping.state === 'pending') {
          await drainIdentityJob(mapping.job);
          continue;
        }
        const held = await heldPrearmJobs(home);
        if (held.length) {
          for (const job of held) await drainIdentityJob(job);
        }
      }
      throw new Error('Native identity mapping did not become current');
    }
    async function admitSubjectMerge(canonical: string, selected: string) {
      for (const id of [canonical, selected]) await awaitCurrentIdentity(id);
      const opened = await send('steward', 'POST', '/v1/platform/exposure/subject_identity:open');
      expect(opened.status).toBe(200);
      const mergeActions = ['subject:merge', 'gate:subject_identity'] as const;
      await grantOnDeadline({ kind: 'account', id: steward.actor.accountId }, mergeActions);
      const mergeBearer = await accountToken({
        ...steward.actor,
        scopes: [...new Set([...steward.actor.scopes, ...mergeActions])],
      });
      const response = await sendWithHeaders(
        mergeBearer,
        'POST',
        '/v1/subjects:merge',
        { subjects: [canonical, selected] },
        { 'idempotency-key': JSON.stringify(entryKey()) },
      );
      expect([200, 202]).toContain(response.status);
      const body = (await response.json()) as { operation?: { id: string } };
      if (body.operation?.id) await drainIdentityMerge(body.operation.id);
      for (const id of [canonical, selected]) await awaitCurrentIdentity(id);
    }
    async function createSubject(vertical: ProfileVertical, label: string = vertical) {
      const response = await send('owner', 'POST', '/v1/subjects', {
        type: entryTypes[vertical],
        labels: { en: label },
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { subject: { id: string; type: string } };
      expect(body.subject.type).toBe(entryTypes[vertical]);
      const id = body.subject.id;
      partitions.add(partitionOf(routeOf(id)!));
      await drainSubjectLinks();
      await awaitCurrentIdentity(id);
      return id;
    }
    function homeKey(accountId: string, home = partitionOf(routeOf(accountId)!)) {
      let key = entryKey();
      let route = subjectTarget(routeKey, accountId, key).route;
      while (partitionOf(route) !== home || route === 0) {
        key = entryKey();
        route = subjectTarget(routeKey, accountId, key).route;
      }
      return key;
    }
    async function createHomeSubject(
      vertical: ProfileVertical,
      person: { actor: AccountActor; bearer: string },
      home = partitionOf(routeOf(person.actor.accountId)!),
      label: string = vertical,
    ) {
      partitions.add(home);
      const key = homeKey(person.actor.accountId, home);
      const response = await send(
        person.bearer,
        'POST',
        '/v1/subjects',
        {
          type: entryTypes[vertical],
          labels: { en: label },
        },
        key,
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { subject: { id: string; type: string } };
      expect(body.subject.type).toBe(entryTypes[vertical]);
      expect(partitionOf(routeOf(body.subject.id)!)).toBe(home);
      partitions.add(home);
      await drainSubjectLinks();
      await awaitCurrentIdentity(body.subject.id);
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
    await awaitCurrentIdentity(baseline);
    expect((await commands.readEntry(owner.actor, baseline)).state).toBe('planned');
    expect((await send('owner', 'GET', `/v1/libraryEntries/${baseline}`)).status).toBe(200);

    return {
      handle: (request: Request) => kernel.handle(request),
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
      createHomeSubject,
      homeKey,
      catchUpIdentity,
      recaptureMappedHomes,
      awaitCurrentIdentity,
      admitSubjectMerge,
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
        await grantOnDeadline({ kind: 'account', id: accountId }, ['gate:personal_library']);
      },
      grantAccountActions,
      async revokeLibraryGate(accountId: string) {
        await grantOnDeadline({ kind: 'account', id: accountId }, ['gate:personal_library'], true);
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
