import { expect, spyOn, test } from 'bun:test';
import { createLogger } from '@better-auth/core/env';
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  authBetterAuthLogger,
  authWorkflowLogger,
  emitAuthDiagnostic,
  emitMembershipStepFailure,
} from '../src/diagnostics.ts';
import { registerMembershipWorkflows, type MembershipWorkInput } from '../src/membership-workflows.ts';

const privateContext = {
  accountId: 'private-account-sentinel',
  actorId: 'private-actor-sentinel',
  clientId: 'private-client-sentinel',
  workflowId: 'private-workflow-sentinel',
  requestId: 'private-request-sentinel',
  body: { email: 'private@example.test', password: 'private-password', hash: 'private-hash' },
  headers: { authorization: 'Bearer private-token', cookie: 'private-cookie' },
  url: 'https://auth.example.test/reset?token=private-reset-token',
  sql: { parameters: ['private-sql-parameter'] },
};

function privateError() {
  return new Error('private-native-message', { cause: new Error('private-cause', { cause: privateContext }) });
}

test('owned diagnostics emit only closed code, operation and severity including every membership step', () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const step of ['reserve', 'publish', 'terminalize', 'release', 'finalize', 'cancel'] as const) {
      emitMembershipStepFailure(step);
      expect(log.mock.calls.at(-1)).toEqual([
        { code: `membership_${step}_failed`, operation: `membership.${step}`, severity: 'error' },
      ]);
    }
    emitAuthDiagnostic('recovery_start_failed');
    expect(log.mock.calls.at(-1)).toEqual([
      { code: 'recovery_start_failed', operation: 'recovery.start', severity: 'error' },
    ]);
    expect(log).toHaveBeenCalledTimes(7);
    emitAuthDiagnostic('private-native-message' as never, 'private-severity' as never);
    expect(log.mock.calls.at(-1)).toEqual([
      { code: 'diagnostic_input_rejected', operation: 'diagnostics', severity: 'error' },
    ]);
  } finally {
    log.mockRestore();
  }
});

test('Better Auth real logger routes each admitted severity without forwarding native arguments', () => {
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const logger = createLogger(authBetterAuthLogger);
    logger.error('private-native-message', privateError(), privateContext);
    logger.warn('private-native-message', privateError(), privateContext);
    expect(error.mock.calls).toEqual([
      [{ code: 'better_auth_diagnostic', operation: 'better_auth', severity: 'error' }],
    ]);
    expect(warn.mock.calls).toEqual([[{ code: 'better_auth_diagnostic', operation: 'better_auth', severity: 'warn' }]]);
    // Do not read/stringify arbitrary SDK metadata, even when its accessors throw.
    const unreadable = new Proxy(
      {},
      {
        get() {
          throw new Error('metadata must remain unread');
        },
      },
    );
    authBetterAuthLogger.log('error', 'private-native-message', unreadable);
    expect(error).toHaveBeenCalledTimes(2);
  } finally {
    error.mockRestore();
    warn.mockRestore();
  }
});

test('DBOS supported logger hook projects real Error/cause/stack and workflow metadata without launching', () => {
  const logs = {
    debug: spyOn(console, 'debug').mockImplementation(() => {}),
    info: spyOn(console, 'info').mockImplementation(() => {}),
    warn: spyOn(console, 'warn').mockImplementation(() => {}),
    error: spyOn(console, 'error').mockImplementation(() => {}),
  };
  try {
    DBOS.setConfig({ name: 'auth-diagnostics-test', logger: authWorkflowLogger, logLevel: 'warn' });
    const logger = DBOS.logger;
    for (const severity of ['debug', 'info', 'warn', 'error'] as const) {
      logger[severity](privateError(), { span: { attributes: privateContext } } as never);
      expect(logs[severity].mock.calls).toEqual([
        [{ code: 'dbos_diagnostic', operation: 'workflow_runtime', severity }],
      ]);
    }
    expect(DBOS.isInitialized()).toBe(false);
  } finally {
    DBOS.setConfig({ name: 'auth-diagnostics-test' });
    for (const log of Object.values(logs)) log.mockRestore();
  }
});

test('real membership step wrapper keeps failure, compensation, denial and retry behavior without personal emission', async () => {
  const step = spyOn(DBOS, 'registerStep').mockImplementation(((fn: unknown) => fn) as never);
  const workflow = spyOn(DBOS, 'registerWorkflow').mockImplementation(((fn: unknown) => fn) as never);
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const calls: string[] = [];
    const input: MembershipWorkInput = {
      kind: 'membership',
      principal: { kind: 'organization', id: privateContext.clientId },
      memberAccountId: privateContext.accountId,
      role: 'member',
      authorization: 'private-approval-reference',
    };
    const run = registerMembershipWorkflows({
      async authorize() {
        calls.push('authorize');
        return {};
      },
      actorAccountId: () => privateContext.actorId,
      async reserve() {
        calls.push('reserve');
        return {
          value: { accountId: input.memberAccountId, principal: input.principal, reservationId: 'private-reservation' },
        };
      },
      async publish() {
        calls.push('publish');
        throw privateError();
      },
      async terminalize() {
        calls.push('terminalize');
      },
      async release() {
        calls.push('release');
      },
    });
    const thrown = await run(input).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Membership workflow step failed: publish');
    expect((thrown as Error).cause).toBeUndefined();
    expect(calls).toEqual(['authorize', 'reserve', 'authorize', 'publish', 'terminalize', 'release']);
    expect(log.mock.calls).toEqual([
      [{ code: 'membership_publish_failed', operation: 'membership.publish', severity: 'error' }],
    ]);
    expect(step.mock.calls.every((call) => call[1]?.retriesAllowed === false)).toBe(true);
    calls.length = 0;
    await expect(run({ ...input, authorization: 'Bearer private-token' })).rejects.toThrow(
      'Membership workflow step failed: reserve',
    );
    expect(calls).toEqual([]);
    expect(log.mock.calls.at(-1)).toEqual([
      { code: 'membership_reserve_failed', operation: 'membership.reserve', severity: 'error' },
    ]);
  } finally {
    step.mockRestore();
    workflow.mockRestore();
    log.mockRestore();
  }
});
