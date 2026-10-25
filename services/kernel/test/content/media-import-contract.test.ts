import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import type { Access, Actor } from '../../src/request/access.ts';
import type { CommandOutcome } from '../../src/command/command.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import {
  importMediaFromUrl,
  readMediaImportStatus,
  type MediaImportDependencies,
  type MediaImportContext,
} from '../../src/content/media-import.ts';
import {
  processImportedMedia,
  type MediaImportJobDependencies,
  type ImportedMediaOutcome,
} from '../../src/content/media-import-job.ts';

test('command, poll and job ports retain native dependency and outcome signatures', () => {
  const command: (
    deps: MediaImportDependencies,
    actor: Actor,
    input: MediaImportRequest,
    context: MediaImportContext,
  ) => Promise<CommandOutcome<{ mediaId: string }>> = importMediaFromUrl;
  const poll: (
    deps: MediaImportDependencies,
    actor: Actor,
    id: string,
    context: { deadline: number },
  ) => Promise<MediaImportStatus | null> = readMediaImportStatus;
  const job: (deps: MediaImportJobDependencies, mediaId: string) => Promise<ImportedMediaOutcome> =
    processImportedMedia;
  const dependencies = (pool: Pool, access: Access, storage: MediaStorage, clock: () => Date) => {
    const deps: MediaImportDependencies = {
      pool,
      access,
      clock,
      routeKey: new Uint8Array(32),
      fetchConfig: { allowedHosts: ['images.example'] },
    };
    const jobDeps: MediaImportJobDependencies = { ...deps, storage };
    return { deps, jobDeps };
  };
  expect([command, poll, job, dependencies].every((value) => typeof value === 'function')).toBe(true);
});

test('unfinished media import ports throw before any dependency or argument access', async () => {
  let touched = false;
  const poison = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('dependency accessed');
      },
    },
  );
  await expect(
    importMediaFromUrl(
      poison as MediaImportDependencies,
      poison as Actor,
      poison as MediaImportRequest,
      poison as MediaImportContext,
    ),
  ).rejects.toThrow('not implemented');
  await expect(
    readMediaImportStatus(poison as MediaImportDependencies, poison as Actor, 'id', poison as { deadline: number }),
  ).rejects.toThrow('not implemented');
  await expect(processImportedMedia(poison as MediaImportJobDependencies, 'id')).rejects.toThrow('not implemented');
  expect(touched).toBe(false);
});
