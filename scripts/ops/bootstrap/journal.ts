import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BootstrapApi } from './api.ts';

export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface JournalEntry {
  method: 'POST' | 'PUT';
  path: string;
  body: unknown;
  intent: string;
  response?: unknown;
}
export interface Journal {
  profile: 'launch-bootstrap-journal-v1';
  planDigest: string;
  actor: string;
  entries: Record<string, JournalEntry>;
}

/** Write-ahead commands are persisted before dispatch. Retrying after a process
 * kill sends the same body, including the original candidate-search receipt.
 * API idempotency remains authoritative even if the response was not saved. */
export class BootstrapJournal {
  constructor(
    readonly state: Journal,
    private readonly save: (state: Journal) => Promise<void>,
  ) {}
  async command<T>(
    api: BootstrapApi,
    key: string,
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    intent: unknown = body,
  ): Promise<T> {
    const intentDigest = digest(intent);
    let entry = this.state.entries[key];
    if (
      entry &&
      (entry.method !== method || entry.path !== path || entry.intent !== intentDigest)
    ) {
      throw new Error(`Bootstrap command ${key} changed its intent`);
    }
    if (entry?.response !== undefined) return entry.response as T;
    if (!entry) {
      entry = { method, path, body: structuredClone(body), intent: intentDigest };
      this.state.entries[key] = entry;
      await this.save(this.state);
    }
    const response = await api.write<T>(method, path, entry.body, key);
    entry.response = response;
    await this.save(this.state);
    return response;
  }
}

export async function openJournal(
  file: string,
  planDigest: string,
  actor: string,
): Promise<BootstrapJournal> {
  let state: Journal;
  try {
    state = JSON.parse(await readFile(file, 'utf8')) as Journal;
    if (
      state.profile !== 'launch-bootstrap-journal-v1' ||
      state.planDigest !== planDigest ||
      state.actor !== actor ||
      !state.entries ||
      typeof state.entries !== 'object' ||
      Array.isArray(state.entries)
    ) {
      throw new Error('Bootstrap journal belongs to another plan or principal');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = { profile: 'launch-bootstrap-journal-v1', planDigest, actor, entries: {} };
  }
  return new BootstrapJournal(state, async (value) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  });
}
