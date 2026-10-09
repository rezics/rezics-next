export interface CommandEnvelope {
  method: string; path: string; body: unknown;
  intent?: string; response?: unknown; result?: unknown;
}
/** Whole-file journals rewrite their record. Per-entry journals write only this command. */
export interface CommandStore<T extends CommandEnvelope> {
  read(): T | undefined;
  write(entry: T): void | Promise<void>;
}

/** Persist the request before dispatch. Replay sends that body and returns a stored outcome. */
export async function replayCommand<T extends CommandEnvelope, R>(store: CommandStore<T>, command: {
  method: T['method']; path: string; body: unknown; intent?: string;
  outcome: 'response' | 'result'; changed: string; fields?: Partial<T>;
}, send: (entry: T) => Promise<R>): Promise<R> {
  const stored = store.read();
  const outcome = (entry: CommandEnvelope) => command.outcome === 'response' ? entry.response : entry.result;
  if (stored && (stored.method !== command.method || stored.path !== command.path
    || (command.intent !== undefined && stored.intent !== command.intent))) throw new Error(command.changed);
  if (stored && outcome(stored) !== undefined) return outcome(stored) as R;
  const entry = stored ?? { method: command.method, path: command.path, body: structuredClone(command.body ?? null),
    ...(command.intent !== undefined ? { intent: command.intent } : {}), ...command.fields } as T;
  if (!stored) await store.write(entry);
  const response = await send(entry);
  const record = entry as CommandEnvelope;
  if (command.outcome === 'response') record.response = response; else record.result = response;
  await store.write(entry);
  return response;
}
