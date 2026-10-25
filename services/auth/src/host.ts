import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createAuthService, type AuthServiceOptions } from './index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts, type WorkflowContext } from './workflows.ts';
import { AUTH_MAINTENANCE_CRON, AUTH_SYSTEM_SCHEMA, registerAuthMaintenance } from './maintenance.ts';

export class AuthHostConfigurationError extends Error {
  override readonly name = 'AuthHostConfigurationError';
  constructor(readonly code: 'database' | 'staging-key' | 'schedule' | 'executor') {
    super(`Invalid Auth host configuration: ${code}`);
  }
}
export interface AuthHostOptions<Context = WorkflowContext> extends AuthServiceOptions {
  /** Both pools belong exclusively to this host and are released by stop(). */
  systemDatabasePool?: Pool;
  /** Defaults to database.options.connectionString; must name the same Auth DB. */
  systemDatabaseUrl?: string;
  stagingKey: Uint8Array;
  access: AccountWorkflowPorts<Context>;
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
    executorId,
  });
  const pools = new Set([options.database, ...(options.systemDatabasePool ? [options.systemDatabasePool] : [])]);
  let ending: Promise<void[]> | undefined;
  const endPools = () => (ending ??= Promise.all([...pools].map((pool) => pool.end())));
  let service;
  try {
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
    auth: service,
    access: options.access,
    executorId,
    handleSignals: false,
    registerWorkflows: () => {
      maintenance = registerAuthMaintenance(service);
    },
  });
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const interrupt = () => {
    void stop();
  };
  const stop = () =>
    (stopping ??= (async () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      await starting?.catch(() => {});
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
    handler: workflows.handler,
    workflows,
    config,
    start() {
      if (stopping) return Promise.reject(new Error('Auth host is stopped'));
      return (starting ??= (async () => {
        try {
          await workflows.start();
          await maintenance!.start(schedule);
          process.once('SIGINT', interrupt);
          process.once('SIGTERM', interrupt);
        } catch (error) {
          await workflows.close();
          await endPools();
          throw error;
        }
      })());
    },
    stop,
  };
}
