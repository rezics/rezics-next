import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import type { Locale } from '../paraglide/runtime.js';
import { kernelClient, requestLocale } from '../kernel/client';
import { nameSubjectTypes, readRelease } from '../subject/definitions';
import { m } from '../paraglide/messages.js';
import type { SessionEnv } from '../session/client';
import {
  changePersonalLibraryEntry,
  libraryEntryStateWrite,
  loadPersonalLibrary,
  presentLibraryStateLabels,
  removePersonalLibraryEntry,
  restorePersonalLibraryEntry,
  type LibraryChangeInput,
  type LibraryMutationResult,
  type LibraryRemoveInput,
  type LibraryRestoreInput,
  type LibraryRestoreResult,
  type PersonalLibraryView,
  type ReloadedLibraryEntry,
} from './entries-read';
import { libraryStateLabel, libraryStateOptions } from './profiles';

async function nameConflict(result: LibraryMutationResult): Promise<LibraryMutationResult> {
  if (!result.ok && result.reason === 'conflict') {
    await nameSubjectTypes([result.entry.subject]);
    const type = result.entry.subject?.type;
    const locale = requestLocale() ?? 'en';
    const release = await readRelease().catch(() => undefined);
    if (!release || !type)
      return {
        ...result,
        entry: { ...result.entry, stateLabel: m.library_other({}, { locale: locale as Locale }), stateOptions: [] },
      };
    return {
      ...result,
      entry: {
        ...result.entry,
        stateLabel:
          libraryStateLabel(release, type, result.entry.state, locale)?.text ??
          m.library_other({}, { locale: locale as Locale }),
        stateOptions: libraryStateOptions(release, type, locale),
      },
    };
  }
  return result;
}

async function nameRestoredEntry(entry: ReloadedLibraryEntry): Promise<ReloadedLibraryEntry> {
  const locale = requestLocale() ?? 'en';
  await nameSubjectTypes([entry.subject]);
  const release = await readRelease().catch(() => undefined);
  const type = entry.subject?.type;
  return {
    ...entry,
    stateLabel:
      release && type
        ? (libraryStateLabel(release, type, entry.state, locale)?.text ??
          m.library_other({}, { locale: locale as Locale }))
        : m.library_other({}, { locale: locale as Locale }),
  };
}

async function nameRestoreResult(result: LibraryRestoreResult): Promise<LibraryRestoreResult> {
  if (result.ok) return { ...result, entry: await nameRestoredEntry(result.entry) };
  if (result.reason === 'occupied' && result.entry) return { ...result, entry: await nameRestoredEntry(result.entry) };
  return result;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateRead(input: unknown): { state?: string; cursor?: string } {
  if (!input || typeof input !== 'object') return {};
  const value = input as Record<string, unknown>;
  return {
    ...(typeof value.state === 'string' ? { state: value.state } : {}),
    ...(typeof value.cursor === 'string' && value.cursor ? { cursor: value.cursor } : {}),
  };
}

function readIdentity(
  value: Record<string, unknown>,
): { subjectId: string; revision: number; idempotencyKey: string; incarnationId?: string | null } | undefined {
  if (
    typeof value.subjectId !== 'string' ||
    value.subjectId.length === 0 ||
    value.subjectId.length > 128 ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.idempotencyKey !== 'string' ||
    !uuid.test(value.idempotencyKey) ||
    (value.incarnationId !== undefined &&
      value.incarnationId !== null &&
      (typeof value.incarnationId !== 'string' || !uuid.test(value.incarnationId)))
  )
    return undefined;
  return {
    subjectId: value.subjectId,
    revision: value.revision,
    idempotencyKey: value.idempotencyKey,
    ...(value.incarnationId === undefined ? {} : { incarnationId: value.incarnationId as string | null }),
  };
}

function validateChange(input: unknown): LibraryChangeInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid library entry');
  const value = input as Record<string, unknown>;
  const identity = readIdentity(value);
  const state = typeof value.state === 'string' ? libraryEntryStateWrite(value.state) : undefined;
  if (!identity || !state) throw new Error('Invalid library entry');
  return { ...identity, state };
}

function validateRemove(input: unknown): LibraryRemoveInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid library entry');
  const identity = readIdentity(input as Record<string, unknown>);
  if (!identity) throw new Error('Invalid library entry');
  return identity;
}

export const readPersonalLibrary = createServerFn({ method: 'GET' })
  .validator(validateRead)
  .handler(async ({ data }): Promise<PersonalLibraryView> => {
    setResponseHeader('cache-control', 'private, no-store');
    const view = await loadPersonalLibrary(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    if (!view.signedIn) return view;
    await nameSubjectTypes(view.entries.map((entry) => entry.subject));
    const release = await readRelease().catch(() => undefined);
    return presentLibraryStateLabels(view, release, requestLocale() ?? 'en');
  });

export const savePersonalLibraryEntry = createServerFn({ method: 'POST' })
  .validator(validateChange)
  .handler(async ({ data }): Promise<LibraryMutationResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return nameConflict(
      await changePersonalLibraryEntry(kernelClient(), getRequest(), env as Partial<SessionEnv>, data),
    );
  });

export const deletePersonalLibraryEntry = createServerFn({ method: 'POST' })
  .validator(validateRemove)
  .handler(async ({ data }): Promise<LibraryMutationResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return nameConflict(
      await removePersonalLibraryEntry(kernelClient(), getRequest(), env as Partial<SessionEnv>, data),
    );
  });

function validateRestore(input: unknown): LibraryRestoreInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid library entry restore');
  const value = input as Record<string, unknown>;
  if (
    typeof value.subjectId !== 'string' ||
    !value.subjectId ||
    value.subjectId.length > 128 ||
    typeof value.deletionId !== 'string' ||
    !value.deletionId ||
    value.deletionId.length > 128 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  )
    throw new Error('Invalid library entry restore');
  return { subjectId: value.subjectId, deletionId: value.deletionId, revision: value.revision as number };
}

export const restorePersonalLibraryEntryAction = createServerFn({ method: 'POST' })
  .validator(validateRestore)
  .handler(async ({ data }): Promise<LibraryRestoreResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return nameRestoreResult(
      await restorePersonalLibraryEntry(kernelClient(), getRequest(), env as Partial<SessionEnv>, data),
    );
  });
