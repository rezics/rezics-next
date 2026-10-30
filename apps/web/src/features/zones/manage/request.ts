import type { KernelClient } from '@rezics/client';
import { MediaProblem } from '../../../media/kernel';
import { isPlatformClosedError } from '../../../kernel/platform-closed';
import type { SessionEnv } from '../../../session/client';
import { prepareSession, viewerCredential } from '../../../session/request';
import { copyStarter } from './starters';
import {
  failure,
  invalidLabels,
  pageLimit,
  validLifecycle,
  type CommandOutcome,
  type CreateCommand,
  type LifecycleCommand,
  type ListInput,
  type ListOutcome,
} from './model';

async function asViewer<T extends ListOutcome | CommandOutcome>(
  request: Request,
  env: Partial<SessionEnv>,
  run: (authorization: string) => Promise<T>,
): Promise<T | Exclude<ListOutcome, { kind: 'ready' }>> {
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { kind: 'signed-out' };
    return await run(authorization);
  } catch (error) {
    if (isPlatformClosedError(error)) return { kind: 'closed' };
    if (error instanceof MediaProblem) return failure(error.problem.status, error.problem);
    return { kind: 'unavailable' };
  }
}

/** One bounded owner-index page. The server selects active/trash and owns continuation validation. */
export async function readOwnedZones(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: ListInput,
): Promise<ListOutcome> {
  return asViewer(request, env, async (authorization): Promise<ListOutcome> => {
    const result = await client.zones.get({
      query: {
        limit: String(pageLimit),
        deleted: String(input.deleted) as 'true' | 'false',
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      headers: { authorization },
    });
    return result.status === 200 && result.data
      ? { kind: 'ready', page: result.data }
      : failure(result.status, result.error?.value);
  });
}

/** The retained command is replayed byte-for-byte after an uncertain response. */
export async function changeOwnedZone(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: LifecycleCommand,
): Promise<CommandOutcome> {
  if (!validLifecycle(command)) return { kind: 'invalid' };
  return asViewer(request, env, async (authorization): Promise<CommandOutcome> => {
    const zone = client.zones({ id: command.id });
    const headers = { authorization, 'if-match': `"${command.revision}"`, 'idempotency-key': command.key };
    const result =
      command.operation === 'delete'
        ? await zone.delete(undefined, { headers })
        : await zone.$restore.post({}, { headers });
    return result.status === 200 && result.data
      ? { kind: 'saved', zone: result.data.zone }
      : failure(result.status, result.error?.value);
  });
}

export async function createOwnedZone(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: CreateCommand,
): Promise<CommandOutcome> {
  const configuration = command && copyStarter(command.starter);
  const fields = command ? invalidLabels(command.labels) : [];
  if (!configuration || !/^[0-9a-f-]{36}$/.test(command.key) || fields.length) return { kind: 'invalid', fields };
  configuration.labels = { ...command.labels };
  return asViewer(request, env, async (authorization): Promise<CommandOutcome> => {
    const headers = { authorization, 'idempotency-key': command.key };
    const result = await client.zones.post(
      { configuration, mounts: [], visibility: 'private' },
      {
        headers,
      },
    );
    return result.status === 201 && result.data
      ? { kind: 'saved', zone: result.data.zone }
      : failure(result.status, result.error?.value);
  });
}
