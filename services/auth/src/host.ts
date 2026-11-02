import {
  organizationDeletionReadTransport,
  type OrganizationDeletionAccess,
} from './organization-deletion-read-transport.ts';
import { automatedOperatorTransport, type AutomatedOperatorAccess } from './automated-operator-transport.ts';
import { accountProfileReadTransport, type AccountProfileAccess } from './account-profile-read-transport.ts';
import {
  accountManagementMembershipTransport,
  type ManagementMembershipAccess,
} from './account-management-membership-transport.ts';
import { randomUUID } from 'node:crypto';
import { createNativeLifecycleResults } from './native-lifecycle-results.ts';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';
import { authManagementClient } from './auth-management-client.ts';
import {
  accountManagementReadTransport,
  type AccountManagementReadAccess,
} from './account-management-read-transport.ts';
import { operatorSessionTransport } from './operator-session-transport.ts';
import { readWorkflowRetentionConfig } from './retention.ts';
import type { Pool } from 'pg';
import { createAuthService, type AuthServiceOptions } from './index.ts';
import { credentialEffects, CredentialEffectDenied } from './credential-effects.ts';
import { createAccountWorkflows, type AccountWorkflowPorts, type WorkflowContext } from './workflows.ts';
import type { TurnstileConfiguration } from './turnstile.ts';
import {
  accountOperationTransport,
  readJsonObject,
  type AccountOperationAccess,
} from './account-operations-transport.ts';
import { AUTH_MAINTENANCE_CRON, AUTH_SYSTEM_SCHEMA, registerAuthMaintenance } from './maintenance.ts';
import {
  AuthRestoreAdmissionError,
  type AuthRestoredGeneration,
  type AuthRestorePendingCode,
} from './restore-admission.ts';
import { reconcileRestoredAuthPage } from './restore-live.ts';
import { createKindConsentParticipant } from './kind-consent.ts';
import { createInternalConsentHandler, type InternalConsentAccessConfiguration } from './internal-consent.ts';

/** Deployment lifecycle for an isolated restored database. It exposes no
 * handler, signer, SDK or maintenance writer. Durable native cursors, not this
 * timer or an in-memory ready bit, own all future reconciliation. */
export function createAuthRestoreHost(options: {
  database: Pool;
  restoredGeneration: AuthRestoredGeneration;
  /** Original native Access controls, as on the ordinary host. No physical owner is installed by this port. */
  trustedAccess?: AuthServiceOptions['trustedAccess'];
}) {
  const restored = options.trustedAccess
    ? { ...options.restoredGeneration, receiving: options.trustedAccess }
    : options.restoredGeneration;
  const kindConsentReceiver = restored.kindConsentReceiver;
  const kindConsent = createKindConsentParticipant({
    database: options.database,
    ...(kindConsentReceiver ? { receiver: kindConsentReceiver } : {}),
  }).writer;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<{ pending: AuthRestorePendingCode }> | undefined;
  let running = false;
  let stopping: Promise<void> | undefined;
  let lastError: unknown;
  const reconcile = () => {
    if (stopping) return Promise.reject(new Error('Auth restore host is stopped'));
    return (active ??= (async () => {
      const fenced = await kindConsent.fenceAll({
        transitionKey: `kind-consent:restore:${options.restoredGeneration.generation}`,
        operation: 'restore-admission',
        identity: options.restoredGeneration.generation,
      });
      if (fenced.status !== 'applied') return { pending: 'source-consumer-pending' as const };
      return reconcileRestoredAuthPage(options.database, restored);
    })()
      .catch((error: unknown) => {
        if (error instanceof AuthRestoreAdmissionError) return { pending: error.code };
        throw error;
      })
      .finally(() => {
        active = undefined;
      }));
  };
  const tick = async () => {
    try {
      await reconcile();
      lastError = undefined;
    } catch (error) {
      lastError = error;
    } finally {
      if (running)
        timer = setTimeout(() => {
          void tick();
        }, 250);
    }
  };
  return {
    reconcile,
    get error() {
      return lastError;
    },
    start() {
      if (stopping) return Promise.reject(new Error('Auth restore host is stopped'));
      if (running) return active ?? Promise.resolve();
      running = true;
      return tick();
    },
    stop() {
      return (stopping ??= (async () => {
        running = false;
        clearTimeout(timer);
        await active?.catch(() => {});
        await options.database.end();
      })());
    },
  };
}

export class AuthHostConfigurationError extends Error {
  override readonly name = 'AuthHostConfigurationError';
  constructor(
    readonly code: 'database' | 'staging-key' | 'schedule' | 'executor' | 'operation-client' | 'private-consent',
  ) {
    super(`Invalid Auth host configuration: ${code}`);
  }
}
export interface AuthHostOptions<Context = WorkflowContext> extends AuthServiceOptions {
  /** Both pools belong exclusively to this host and are released by stop(). */
  systemDatabasePool?: Pool;
  /** Defaults to database.options.connectionString; must name the same Auth DB. */
  systemDatabaseUrl?: string;
  stagingKey: Uint8Array;
  /** Cloudflare Siteverify configuration for the public sign-up endpoint. */
  turnstile?: TurnstileConfiguration;
  access: AccountWorkflowPorts<Context>;
  /** Kernel workflow approval and gate ports for the account-operation routes.
   * Absent, both routes answer 503 account_operation_denied. */
  accountOperations?: AccountOperationAccess;
  /** Dedicated Cloudflare Access trust for the private consent listener. */
  privateConsent?: InternalConsentAccessConfiguration;
  /** Independent native read binding; defaults to the additive accountOperations port. */
  accountManagementReads?: AccountManagementReadAccess;
  executorId?: string;
  /** UTC five- or six-field numeric cron expression. */
  maintenanceSchedule?: string;
}
function databaseIdentity(value: string | undefined) {
  try {
    const url = new URL(value!);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2 ||
      ['host', 'hostaddr', 'port', 'database', 'dbname', 'service', 'options'].some((field) =>
        url.searchParams.has(field),
      )
    )
      throw new Error();
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    throw new AuthHostConfigurationError('database');
  }
}
function validateSchedule(schedule: string) {
  const fields = schedule.trim().split(/\s+/);
  const ranges = fields.length === 5 ? [59, 23, 31, 12, 6] : fields.length === 6 ? [59, 59, 23, 31, 12, 6] : [];
  if (
    !ranges.length ||
    fields.some((field, index) =>
      field.split(',').some((part) => {
        const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
        if (!match || (match[2] !== undefined && (+match[2] < 1 || +match[2] > ranges[index]!))) return true;
        if (match[1] === '*') return false;
        const values = match[1]!.split('-').map(Number);
        const minimum = index === fields.length - 2 || index === fields.length - 3 ? 1 : 0;
        return (
          values.some((value) => value < minimum || value > ranges[index]!) ||
          (values.length === 2 && values[0]! > values[1]!)
        );
      }),
    )
  )
    throw new AuthHostConfigurationError('schedule');
}

/** Explicit production composition. Library service construction never starts
 * DBOS. All account and maintenance workflows register before one SDK launch. */
export async function createAuthHost<Context = WorkflowContext>(options: AuthHostOptions<Context>) {
  const retention = readWorkflowRetentionConfig(process.env);
  const systemDatabaseUrl = options.systemDatabaseUrl ?? options.database.options.connectionString;
  const identity = databaseIdentity(options.database.options.connectionString);
  if (
    databaseIdentity(systemDatabaseUrl) !== identity ||
    (options.systemDatabasePool && databaseIdentity(options.systemDatabasePool.options.connectionString) !== identity)
  )
    throw new AuthHostConfigurationError('database');
  if (options.stagingKey.byteLength !== 32) throw new AuthHostConfigurationError('staging-key');
  const schedule = options.maintenanceSchedule ?? AUTH_MAINTENANCE_CRON;
  validateSchedule(schedule);
  const executorId = options.executorId ?? `auth-${randomUUID()}`;
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(executorId)) throw new AuthHostConfigurationError('executor');
  const config = Object.freeze({
    systemDatabaseSchemaName: AUTH_SYSTEM_SCHEMA,
    maintenanceSchedule: schedule,
    workflowRetentionDays: retention.retentionDays,
    executorId,
  });
  const pools = new Set([options.database, ...(options.systemDatabasePool ? [options.systemDatabasePool] : [])]);
  let ending: Promise<void[]> | undefined;
  const endPools = () => (ending ??= Promise.all([...pools].map((pool) => pool.end())));
  let service;
  try {
    // Service construction performs restore admission before signer creation.
    // A refusal happens before workflows/maintenance register or a handler escapes.
    service = await createAuthService(options);
  } catch (error) {
    await endPools();
    throw error;
  }
  let maintenance: ReturnType<typeof registerAuthMaintenance>;
  const workflows = createAccountWorkflows({
    database: options.database,
    systemDatabaseUrl: systemDatabaseUrl!,
    systemDatabaseSchemaName: AUTH_SYSTEM_SCHEMA,
    ...(options.systemDatabasePool ? { systemDatabasePool: options.systemDatabasePool } : {}),
    stagingKey: options.stagingKey,
    ...(options.turnstile ? { turnstile: options.turnstile } : {}),
    auth: service,
    access: options.access,
    ...(options.trustedAccess.completeRecovery ? { completeRecovery: options.trustedAccess.completeRecovery } : {}),
    executorId,
    handleSignals: false,
    registerWorkflows: () => {
      maintenance = registerAuthMaintenance(service, retention, () => workflows.redriveNativeErasure());
    },
  });
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  if (!service) throw new Error('Auth service did not start');
  const auth = service;
  let privateConsentAccepting = false;
  let privateConsentHandler: ((request: Request) => Promise<Response>) | undefined;
  if (options.privateConsent) {
    try {
      const listener = createInternalConsentHandler({
        ...options.privateConsent,
        database: options.database,
        kindConsentParticipant: auth.internal.kindConsentParticipant,
      });
      privateConsentHandler = (request) =>
        privateConsentAccepting
          ? listener(request)
          : Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
    } catch {
      await endPools();
      throw new AuthHostConfigurationError('private-consent');
    }
  }
  // Point-read only. registerClient takes the client advisory lock on its own
  // connection, so holding that lock here would deadlock. An existing login
  // client is left unchanged, including one registered with scopes.
  const registerLoginClient = async () => {
    const present = await options.database.query('SELECT 1 FROM auth_client WHERE client_id=$1', ['login']);
    if (present.rowCount) return;
    await auth.internal.registerClient({ clientId: 'login', firstParty: true, scopes: [] });
  };
  const interrupt = () => {
    void stop();
  };
  const stop = () =>
    (stopping ??= (async () => {
      privateConsentAccepting = false;
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      await starting?.catch(() => {});
      privateConsentAccepting = false;
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      // Native recovery/scheduling shuts down before any product or injected SDK pool.
      try {
        await workflows.close();
      } finally {
        await endPools();
      }
    })());
  return {
    service,
    /** Private server composition; never mounted by any transport. */
    nativeLifecycleResults: createNativeLifecycleResults({ database: options.database, access: options.trustedAccess }),
    /** Serve only on the separately configured private Tunnel/Access listener.
     * The handler is gated by this host's start/stop lifecycle. */
    privateConsentHandler,
    handler: accountOperationTransport(
      service,
      workflows,
      operatorSessionTransport(
        service,
        workflows,
        accountManagementReadTransport(
          service,
          accountManagementMembershipTransport(
            service,
            automatedOperatorTransport(
              service,
              organizationDeletionReadTransport(
                service,
                accountProfileReadTransport(
                  service,
                  credentialEffectTransport(service, workflows.handler, options),
                  (options.trustedAccess as typeof options.trustedAccess & Partial<AccountProfileAccess>)
                    .readRenameAccountProfile
                    ? (options.trustedAccess as typeof options.trustedAccess & AccountProfileAccess)
                    : undefined,
                ),
                (options.trustedAccess as typeof options.trustedAccess & Partial<OrganizationDeletionAccess>)
                  .readOrganizationForDeletion
                  ? (options.trustedAccess as typeof options.trustedAccess & OrganizationDeletionAccess)
                  : undefined,
              ),
              (options.trustedAccess as typeof options.trustedAccess & Partial<AutomatedOperatorAccess>)
                .readAutomatedCreationOperator
                ? (options.trustedAccess as typeof options.trustedAccess & AutomatedOperatorAccess)
                : undefined,
            ),
            (options.trustedAccess as typeof options.trustedAccess & Partial<ManagementMembershipAccess>)
              .readOrganizationMembershipCommandState
              ? (options.trustedAccess as typeof options.trustedAccess & ManagementMembershipAccess)
              : undefined,
          ),
          options.accountManagementReads ?? options.accountOperations,
        ),
        options.accountOperations,
      ),
      options.accountOperations,
    ),
    workflows,
    config,
    start() {
      if (stopping) return Promise.reject(new Error('Auth host is stopped'));
      return (starting ??= (async () => {
        try {
          try {
            await auth.internal.registerClient({
              clientId: AUTH_PAGE_OPERATION_CLIENT_ID,
              firstParty: true,
              scopes: [...new Set(Object.values(AUTH_PAGE_OPERATION_SCOPES).flat())],
              mode: 'create-or-match',
            });
            await auth.internal.registerClient(authManagementClient);
          } catch (error) {
            if (error instanceof Error && 'status' in error && (error.status === 400 || error.status === 401))
              throw new AuthHostConfigurationError('operation-client');
            throw error;
          }
          await registerLoginClient();
          await workflows.start();
          await maintenance!.start(schedule);
          privateConsentAccepting = true;
          process.once('SIGINT', interrupt);
          process.once('SIGTERM', interrupt);
        } catch (error) {
          privateConsentAccepting = false;
          await workflows.close();
          await endPools();
          throw error;
        }
      })());
    },
    stop,
  };
}

/** Auth-host transport only. Secret input never enters a workflow or its log. */
export function credentialEffectTransport(
  service: Awaited<ReturnType<typeof createAuthService>>,
  fallback: (request: Request) => Promise<Response>,
  options: Pick<AuthServiceOptions, 'database' | 'secret'>,
): (request: Request) => Promise<Response> {
  const effects = credentialEffects(options.database, options.secret);
  return async (request) => {
    const url = new URL(request.url);
    const command = new Map([
      ['/credential-effects/stage', 'stage'],
      ['/credential-effects/approve', 'approve'],
      ['/credential-effects/apply', 'apply'],
    ]).get(url.pathname);
    if (!command) return fallback(request);
    const deadline = Date.now() + 3000;
    const response = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    const denied = (status: number) =>
      response({ error: 'credential_effect_denied', effect_status: 'not_applied' }, status);
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return denied(400);
    try {
      const body = await readJsonObject(request);
      const names =
        command === 'stage'
          ? ['key', 'subjectId', 'credential']
          : ['key', 'subjectId', 'effectRef', 'purpose', 'digest', ...(command === 'apply' ? ['reference'] : [])];
      if (Object.keys(body).some((field) => !names.includes(field))) return denied(400);
      const string = (value: unknown): string => {
        if (typeof value !== 'string' || !value || value.length > 1024) throw new CredentialEffectDenied(400);
        return value;
      };
      const input = { key: string(body.key), subjectAccountId: string(body.subjectId), headers: request.headers };
      if (command === 'stage')
        return response(
          (body.credential as { kind?: string } | undefined)?.kind === 'passkey'
            ? await service.internal.stagePasskeyEffect({
                ...input,
                credential: body.credential as Parameters<typeof service.internal.stagePasskeyEffect>[0]['credential'],
              })
            : await service.internal.stageCredentialEffect({
                ...input,
                credential: body.credential as Parameters<
                  typeof service.internal.stageCredentialEffect
                >[0]['credential'],
              }),
        );
      const effectRef = string(body.effectRef);
      // These hostile transport fields only compare with Auth's committed stage.
      if (body.purpose !== undefined || body.digest !== undefined) {
        const { binding: stage } = await effects.read(effectRef);
        if (
          (body.purpose !== undefined && body.purpose !== stage.purpose) ||
          (body.digest !== undefined && body.digest !== stage.effectDigest)
        )
          return denied(401);
      }
      if (command === 'approve') {
        const requestInput = { ...input, effectRef, deadline };
        return response(await service.internal.approveCredentialEffect(requestInput));
      }
      const requestInput = {
        ...input,
        effectRef,
        authorization: string(body.reference),
        deadline,
      };
      return response(await service.internal.applyCredentialEffect(requestInput));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'step_up_required')
        return response({ error: 'step_up_required', effect_status: 'not_applied' }, 401);
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return denied(typeof status === 'number' && [400, 401, 403, 409, 413, 415, 503].includes(status) ? status : 503);
    }
  };
}
