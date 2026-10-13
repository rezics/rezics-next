import { randomUUID } from 'node:crypto';
import { settlePendingAnswer, type RaceOptions } from './command-race.ts';
import type { PersonaSession } from './personas.ts';

/** Preparation reads a reconciling command to its end; proofs inspect their first answer. */
export async function settledWrite(
  main: PersonaSession['main'],
  method: string,
  path: string,
  body?: unknown,
  key: string = randomUUID(),
  options: RaceOptions = {},
): Promise<Response> {
  const send = () => main(method, path, body, key);
  const initial = await send();
  let last = { status: initial.status, body: await initial.clone().text() };
  return settlePendingAnswer(initial, send, options,
    reason => { throw new Error(`Fixture write ${method} ${path}: ${reason}; last answer=${JSON.stringify(last)}`); },
    async response => { last = { status: response.status, body: await response.clone().text() }; });
}
