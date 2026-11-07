import type { QueryConfig } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { AuthenticationError } from './contract/index.ts';
import { AccessUnavailableError, throwAccessUnavailable } from './unavailable.ts';

const invalid = () => new AuthenticationError(401, 'Bearer error="invalid_token"');

export function remaining(deadline: number): number {
  if (!Number.isFinite(deadline)) throw invalid();
  if (Date.now() >= deadline) throw new AccessUnavailableError('deadline');
  return Math.max(1, Math.floor(deadline - Date.now()));
}

/** Also bounds pool queueing and transports that do not honor AbortSignal. */
export async function within<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  const ms = remaining(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AccessUnavailableError('deadline')), ms);
      }),
    ]);
    remaining(deadline);
    return result;
  } catch (error) {
    throwAccessUnavailable(error, deadline);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Preserve pg's decoding capabilities when wrapping reylo's query transport. */
export function deadlineClient(client: AccessClient, deadline: number): AccessClient {
  const bounded = Object.create(client) as AccessClient;
  bounded.query = ((query: QueryConfig | string, values?: unknown[]) => {
    const config = {
      ...(typeof query === 'string' ? { text: query, values: values ?? [] } : query),
      query_timeout: remaining(deadline),
    };
    return within(deadline, () => client.query(config));
  }) as AccessClient['query'];
  return bounded;
}
