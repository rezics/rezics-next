import type { ZoneConfiguration } from '@rezics/composition';
import type { KernelClient } from '@rezics/client';
import { MediaProblem } from '../../../media/kernel';
import { isPlatformClosedError } from '../../../kernel/platform-closed';
import type { SessionEnv } from '../../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../../session/request';
import type { OwnerReadObservation } from '../editor/owner-lifetime';
import { copyStarter } from './starters';
import {
  failure,
  invalidLabels,
  pageLimit,
  validLifecycle,
  type CommandOutcome,
  type CreateCommand,
  type Failure,
  type LifecycleCommand,
  type ListInput,
  type ListOutcome,
} from './model';

async function asViewer<T extends ListOutcome | CommandOutcome>(
  request: Request,
  env: Partial<SessionEnv>,
  run: (authorization: string) => Promise<T>,
  expected?: OwnerReadObservation,
): Promise<T | Failure> {
  let preparedReader: string | undefined;
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    const reader = sessionSubject(request);
    if (stale || !authorization) return { kind: 'signed-out' };
    if (expected && !reader) return { kind: 'stale' };
    preparedReader = reader;
    if (expected && (expected.reader !== reader || !/^\d+:\d+:[0-9a-f-]{36}$/.test(expected.admission)))
      return { kind: 'stale' };
    const result = await run(authorization);
    return expected ? { ...result, ownerObservation: { reader: reader!, admission: expected.admission } } : result;
  } catch (error) {
    const outcome = isPlatformClosedError(error)
      ? { kind: 'closed' as const }
      : error instanceof MediaProblem
        ? failure(error.problem.status, error.problem)
        : { kind: 'unavailable' as const };
    return expected && preparedReader === expected.reader
      ? { ...outcome, ownerObservation: { reader: preparedReader, admission: expected.admission } }
      : outcome;
  }
}

/** One bounded owner-index page. The server selects active/trash and owns continuation validation. */
export async function readOwnedZones(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: ListInput,
  expected?: OwnerReadObservation,
): Promise<ListOutcome> {
  return asViewer(
    request,
    env,
    async (authorization): Promise<ListOutcome> => {
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
    },
    expected,
  );
}

/** The retained command is replayed byte-for-byte after an uncertain response. */
export async function changeOwnedZone(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: LifecycleCommand,
  expected?: OwnerReadObservation,
): Promise<CommandOutcome> {
  if (!validLifecycle(command)) return { kind: 'invalid' };
  return asViewer(
    request,
    env,
    async (authorization): Promise<CommandOutcome> => {
      const zone = client.zones({ id: command.id });
      const headers = { authorization, 'if-match': `"${command.revision}"`, 'idempotency-key': command.key };
      const result =
        command.operation === 'delete'
          ? await zone.delete(undefined, { headers })
          : await zone.$restore.post({}, { headers });
      return result.status === 200 && result.data
        ? { kind: 'saved', zone: result.data.zone }
        : failure(result.status, result.error?.value);
    },
    expected,
  );
}

export async function createOwnedZone(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: CreateCommand,
  expected?: OwnerReadObservation,
): Promise<CommandOutcome> {
  const configuration: ZoneConfiguration | undefined = command && copyStarter(command.starter);
  const fields = command ? invalidLabels(command.labels, command.primaryLanguage) : [];
  if (!configuration || !/^[0-9a-f-]{36}$/.test(command.key) || fields.length) return { kind: 'invalid', fields };
  configuration.labels = { ...command.labels };
  if (command.primaryLanguage !== undefined) configuration.primaryLanguage = command.primaryLanguage;
  return asViewer(
    request,
    env,
    async (authorization): Promise<CommandOutcome> => {
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
    },
    expected,
  );
}
