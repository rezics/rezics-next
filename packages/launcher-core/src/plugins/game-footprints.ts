import { gameFootprintsPlugin, type CompletedGameSession, type GameSessionObserver } from '@rezics/launcher-contract';
import { createWriteStream } from 'node:fs';
import { link, opendir, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isMissing, readJson, writeJson } from '../storage.ts';

const day = 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class LocalFootprints {
  private readonly settings: string;
  private readonly directory: string;
  private failure: string | null = null;
  private readonly pending = new Set<Promise<void>>();

  constructor(root: string) {
    this.settings = join(root, 'footprints-settings.json');
    this.directory = join(root, 'footprints');
  }

  async status() {
    const settings = await readJson<{ enabled?: boolean }>(this.settings);
    return { enabled: settings?.enabled === true, error: this.failure };
  }

  async enable(enabled: boolean) {
    await writeJson(this.settings, { enabled });
    return this.status();
  }

  async record(targetId: string, { sessionId: originId, startedAt, elapsedMs }: CompletedGameSession) {
    if (!uuid.test(targetId) || !uuid.test(originId)) return undefined;
    const elapsed = Math.floor(elapsedMs);
    if (elapsed < 1) return;
    if (elapsed > 31 * day) {
      this.failure = 'An activity exceeded the maximum 31-day process interval.';
      return;
    }
    const writing = writeJson(join(this.directory, `${originId}.json`), {
      originId,
      targetId,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(startedAt + elapsed).toISOString(),
      durationSeconds: Math.floor(elapsed / 1000),
    });
    this.pending.add(writing);
    try {
      await writing;
    } catch {
      this.failure = 'A completed game could not be saved to the local footprint history.';
    } finally {
      this.pending.delete(writing);
    }
  }

  async export(destination: string, replace: boolean) {
    await Promise.allSettled(this.pending);
    const directory = this.directory;
    const lines = async function* () {
      yield '{"format":"rezics-launcher-footprints","version":1}\n';
      const entries = await opendir(directory).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
        return undefined;
      });
      if (!entries) return;
      for await (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || !uuid.test(entry.name.slice(0, -5))) continue;
        const line = await readFile(join(directory, entry.name), 'utf8');
        if (line.length > 1024 || line.includes('\n')) throw new Error('A local footprint is unreadable.');
        yield line + '\n';
      }
    };
    const temporary = join(dirname(destination), `.rezics-footprints-${randomUUID()}.tmp`);
    try {
      await pipeline(Readable.from(lines()), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (replace) {
        await rename(temporary, destination);
      } else {
        try {
          await link(temporary, destination);
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
            throw new Error('There is already a file at the chosen footprints destination.');
          }
          throw error;
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function createGameFootprints(root: string) {
  const store = new LocalFootprints(root);
  const prepareGameSession: GameSessionObserver = async (subjectId) => {
    if (subjectId && (await store.status()).enabled) return (session) => store.record(subjectId, session);
  };
  return {
    manifest: gameFootprintsPlugin,
    prepareGameSession,
    status: () => store.status(),
    enable: (enabled: boolean) => store.enable(enabled),
    export: (destination: string, replace = true) => store.export(destination, replace),
  };
}
