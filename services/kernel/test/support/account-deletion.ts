import type { Pool } from 'pg';
import { routeOf } from '../../src/route/route.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import type { Persona, PersonasOptions } from './personas.ts';

export type AccountDeletionErrorBody = { error?: unknown; effect_status?: unknown; [key: string]: unknown };

export type AccountDeletionRuntime = {
  auth: Parameters<typeof deletePersona>[0]['auth'];
  person(): Promise<{ accountId: string; bearer: string }>;
};
const runtimes = new WeakMap<object, AccountDeletionRuntime>();

/** Keep fixture-only native Auth ports outside the frozen product driver shape. */
export function registerAccountDeletionRuntime(system: object, runtime: AccountDeletionRuntime): void {
  runtimes.set(system, runtime);
}
export function accountDeletionRuntime(system: object): AccountDeletionRuntime {
  const runtime = runtimes.get(system);
  if (!runtime) throw new Error('Native account deletion runtime is unavailable');
  return runtime;
}

export class AccountDeletionError extends Error {
  constructor(
    readonly status: number,
    readonly body: AccountDeletionErrorBody,
  ) {
    super(`Auth refused account deletion: ${status} ${JSON.stringify(body)}`);
    this.name = 'AccountDeletionError';
  }
}

function cookies(response: Response): Headers {
  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((item) => item.split(';')[0])
      .join('; '),
  });
}

/**
 * Delete through Auth's step-up operation transport as a freshly signed-in human. An operated account is
 * deleted by its operator and includes the current operator responsibility; a successful deletion returns
 * the erasure T point read from Access.
 *
 * Cost: one sign-in, two Auth requests and one status point read per deletion; constant per deletion.
 */
export async function deletePersona(
  options: Pick<PersonasOptions, 'pool'> & Partial<Pick<PersonasOptions, 'version'>> & {
    auth: Pick<PersonasOptions['auth'], 'request' | 'authPool'> & {
      host: Pick<PersonasOptions['auth']['host'], 'handler'> & {
        service: Pick<PersonasOptions['auth']['host']['service'], 'verifier'>;
      };
    };
  },
  persona: Persona,
  input: { actingHuman?: Persona } = {},
): Promise<{ accountId: string; at: string }> {
  const actingHuman = input.actingHuman ?? persona;
  const client = await options.auth.authPool.query<{ client_id: string; scopes: string[] }>(
    `SELECT c.client_id,c.scopes FROM auth_consent consent JOIN auth_client c USING(client_id)
     WHERE consent.account_id=$1 AND 'account:delete'=ANY(consent.scopes)
       AND 'account:delete'=ANY(c.scopes) ORDER BY c.client_id LIMIT 1`,
    [actingHuman.accountId],
  );
  const authorizedClient = client.rows[0];
  if (!authorizedClient) throw new Error(`No Auth client consent exists for acting human ${actingHuman.accountId}`);
  const clientId = authorizedClient.client_id;
  if (!clientId) throw new Error(`No Auth client consent exists for acting human ${actingHuman.accountId}`);

  const signedIn = await options.auth.request('/signin', {
    account_id: actingHuman.accountId,
    password: 'ordinary native registration password',
    client_id: clientId,
    scope: authorizedClient.scopes,
  });
  if (signedIn.status !== 200) {
    const body = (await signedIn.json().catch(() => ({}))) as AccountDeletionErrorBody;
    throw new AccountDeletionError(signedIn.status, body);
  }
  const headers = cookies(signedIn);
  const relation = await options.pool.query<{
    operator_account_id: string | null;
    operator_reservation_id: string | null;
  }>(
    'SELECT operator_account_id::text,operator_reservation_id::text FROM access.account WHERE route=$1 AND account_id=$2',
    [routeOf(persona.accountId), persona.accountId],
  );
  const current = relation.rows[0];
  const responsibility = current?.operator_account_id
    ? {
        operatorAccountId: current.operator_account_id,
        subjectAccountId: persona.accountId,
        reservationId: current.operator_reservation_id,
      }
    : undefined;
  const operation = {
    kind: 'delete',
    accountId: persona.accountId,
    ...(responsibility ? { responsibility } : {}),
  };
  const operationKey = crypto.randomUUID();
  const post = async (path: string, body: unknown) =>
    options.auth.host.handler(
      new Request(`${options.auth.host.service.verifier.issuer}${path}`, {
        method: 'POST',
        headers: {
          origin: new URL(options.auth.host.service.verifier.issuer).origin,
          'content-type': 'application/json',
          cookie: headers.get('cookie') ?? '',
        },
        body: JSON.stringify(body),
      }),
    );
  const approved = await post('/account-operations/approve', { operationKey, operation });
  if (!approved.ok) {
    const body = (await approved.json().catch(() => ({}))) as AccountDeletionErrorBody;
    throw new AccountDeletionError(approved.status, body);
  }
  const approval = (await approved.json()) as { reference?: unknown };
  if (typeof approval.reference !== 'string' || !approval.reference)
    throw new AccountDeletionError(approved.status, { error: 'invalid_approval_response' });
  const executed = await post('/account-operations/execute', {
    operationKey,
    operation,
    reference: approval.reference,
  });
  if (!executed.ok) {
    const body = (await executed.json().catch(() => ({}))) as AccountDeletionErrorBody;
    throw new AccountDeletionError(executed.status, body);
  }
  const result = (await executed.json()) as { accountId?: unknown };
  if (result.accountId !== persona.accountId)
    throw new AccountDeletionError(executed.status, { error: 'invalid_execute_response', accountId: result.accountId });
  const status = await readErasureStatus(options.pool, persona.accountId);
  if (!status) throw new Error(`Auth deleted account ${persona.accountId} without an erasure status`);
  return { accountId: persona.accountId, at: status.at };
}

export class EffectsDrainDeadlineError extends Error {
  constructor(
    readonly partition: number,
    readonly deadlineMs: number,
  ) {
    super(`Effects consumer did not reach partition ${partition} within ${deadlineMs}ms`);
    this.name = 'EffectsDrainDeadlineError';
  }
}

/** Wait only for the effects consumer to reach this partition's current head, using two point reads per poll. */
export async function drainEffects(
  pool: Pool,
  partition: number,
  { deadlineMs = 30000 }: { deadlineMs?: number } = {},
) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ position: string; checkpoint: string | null }>(
      `SELECT p.position::text, c.position::text AS checkpoint
       FROM core.partition p LEFT JOIN core.consumer_checkpoint c
         ON c.partition_no=p.partition_no AND c.consumer='effects'
       WHERE p.partition_no=$1`,
      [partition],
    );
    const head = BigInt(result.rows[0]?.position ?? 0);
    const checkpoint = BigInt(result.rows[0]?.checkpoint ?? 0);
    if (checkpoint >= head) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(15, Math.max(0, deadline - Date.now()))));
  }
  throw new EffectsDrainDeadlineError(partition, deadlineMs);
}
