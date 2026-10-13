import { randomUUID } from 'node:crypto';

type Create = (method: 'POST', path: string, body: unknown, key: string) => Promise<Response>;

interface Options {
  /** Replays of one pending provision before setup gives up. */
  replays?: number;
  sleep?: (ms: number) => Promise<unknown>;
  key?: string;
}

/**
 * Creates a persona's Person Agent as a client of the API must: a provision the
 * API has not finished answers 202, and the same idempotency key reads its end.
 * A loaded host leaves the first answer pending; that is not a failed setup.
 */
export async function provisionedAgent(main: Create, displayName: string, options: Options = {}): Promise<string> {
  const key = options.key ?? randomUUID();
  const replays = options.replays ?? 60;
  const sleep = options.sleep ?? Bun.sleep;
  for (let replay = 0; ; replay++) {
    const response = await main('POST', '/v1/agents', { profile: 'agent-provision-v1', kind: 'person', displayName }, key);
    const body = await response.text();
    if (response.status === 201 || (replay > 0 && response.status === 200)) return (JSON.parse(body) as { agent: string }).agent;
    if (response.status !== 202 || replay === replays)
      throw new Error(`Persona setup expected HTTP 201, got ${response.status}${replay ? ` after ${replay} replays` : ''}: ${body}`);
    await sleep(1000);
  }
}
