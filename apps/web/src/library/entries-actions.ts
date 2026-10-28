import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { nameSubjectTypes } from '../subject/definitions';
import type { SessionEnv } from '../session/client';
import {
  changePersonalLibraryEntry,
  libraryEntryStateWrite,
  loadPersonalLibrary,
  removePersonalLibraryEntry,
  type LibraryChangeInput,
  type LibraryMutationResult,
  type LibraryRemoveInput,
  type PersonalLibraryView,
} from './entries-read';

async function nameConflict(result: LibraryMutationResult): Promise<LibraryMutationResult> {
  if (!result.ok && result.reason === 'conflict') await nameSubjectTypes([result.entry.subject]);
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
): { subjectId: string; revision: number; idempotencyKey: string } | undefined {
  if (
    typeof value.subjectId !== 'string' ||
    value.subjectId.length === 0 ||
    value.subjectId.length > 128 ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.idempotencyKey !== 'string' ||
    !uuid.test(value.idempotencyKey)
  )
    return undefined;
  return { subjectId: value.subjectId, revision: value.revision, idempotencyKey: value.idempotencyKey };
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
    if (view.signedIn) {
      const shown = view.state === null ? view.sections.flatMap((section) => section.entries) : view.entries;
      await nameSubjectTypes(shown.map((entry) => entry.subject));
    }
    return view;
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
