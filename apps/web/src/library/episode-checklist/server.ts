import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { fetchGuideRelease } from '../../features/catalogue/definition-guide';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { CANONICAL_ID, type ChecklistIntent } from './contract';
import { bindFromDetail, continueRetainedEpisodes, loadEpisodeChecklist, readbackInspect } from './load';
import { recordEpisodes } from './native';
import type { EpisodeRecordResult } from './native';
import type { EpisodeLoad } from './load';

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_ID.test(value)) throw new Error('Invalid episode checklist request');
  return value;
}

async function authorization(): Promise<string | null> {
  const request = getRequest();
  if (await prepareSession(request, env as Partial<SessionEnv>)) return null;
  return viewerCredential(request);
}

export const loadCanonicalEpisodeChecklist = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid episode checklist request');
    const value = input as Record<string, unknown>;
    if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) {
      throw new Error('Invalid episode checklist request');
    }
    if (typeof value.locale !== 'string' || value.locale.length < 2 || value.locale.length > 16) {
      throw new Error('Invalid episode checklist request');
    }
    return {
      sessionId: requiredId(value.sessionId),
      subjectId: requiredId(value.subjectId),
      revision: value.revision,
      locale: value.locale,
      viewer: typeof value.viewer === 'string' ? value.viewer : null,
    };
  })
  .handler(async ({ data }): Promise<EpisodeLoad> => {
    setResponseHeader('cache-control', 'private, no-store');
    const binding = bindFromDetail(data);
    const client = kernelClient();
    const token = await authorization();
    return loadEpisodeChecklist(
      client,
      getRequest(),
      env as Partial<SessionEnv>,
      binding,
      fetchGuideRelease(client, undefined, token ? { authorization: token } : {}),
    );
  });

export const inspectCanonicalEpisodes = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid episode checklist request');
    const value = input as Record<string, unknown>;
    if (!Array.isArray(value.ids) || value.ids.some((id) => typeof id !== 'string')) {
      throw new Error('Invalid episode checklist request');
    }
    return { sessionId: requiredId(value.sessionId), ids: value.ids as string[] };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const token = await authorization();
    if (!token) return { kind: 'denied' as const };
    return readbackInspect(kernelClient(), data.sessionId, token, data.ids);
  });

export const continueCanonicalEpisodes = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid episode checklist request');
    const value = input as Record<string, unknown>;
    if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 4096)) {
      throw new Error('Invalid episode checklist request');
    }
    return {
      sessionId: requiredId(value.sessionId),
      ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const token = await authorization();
    if (!token) return { kind: 'denied' as const };
    return continueRetainedEpisodes(kernelClient(), data.sessionId, token, data.cursor);
  });

function intentOf(value: unknown): ChecklistIntent {
  if (!value || typeof value !== 'object') throw new Error('Invalid episode checklist request');
  const intent = value as Record<string, unknown>;
  if (intent.kind === 'clear') return { kind: 'clear' };
  if (intent.kind !== 'patch' || !Array.isArray(intent.add) || !Array.isArray(intent.remove)) {
    throw new Error('Invalid episode checklist request');
  }
  return { kind: 'patch', add: intent.add as string[], remove: intent.remove as string[] };
}

export const recordCanonicalEpisodes = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid episode checklist request');
    const value = input as Record<string, unknown>;
    if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) {
      throw new Error('Invalid episode checklist request');
    }
    if (typeof value.key !== 'string' || value.key.length < 1 || value.key.length > 255) {
      throw new Error('Invalid episode checklist request');
    }
    return {
      sessionId: requiredId(value.sessionId),
      revision: value.revision,
      key: value.key,
      intent: intentOf(value.intent),
    };
  })
  .handler(async ({ data }): Promise<EpisodeRecordResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const token = await authorization();
    if (!token) return { ok: false, kind: 'denied' };
    return recordEpisodes(kernelClient(), data.sessionId, token, data.key, data.revision, data.intent);
  });
