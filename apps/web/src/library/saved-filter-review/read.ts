import type { KernelClient } from '@rezics/client';
import { parseFilter } from '@rezics/filter';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { conditionMetadata, type ConditionMetadata } from '../../search/condition-editor-model';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import type { SavedRule } from '../collection-rule-read';

export type ReviewMetadataState = 'ready' | 'preparing' | 'unavailable';
export type ReviewRelease = {
  state: ReviewMetadataState;
  digest?: string;
  metadata?: ConditionMetadata;
};
export type SavedFilterReviewPage =
  | { state: 'denied' | 'unavailable' }
  | {
      state: 'ready';
      id: string;
      viewerId: string;
      title: string;
      rule: SavedRule;
      accepted: ReviewRelease;
      current: ReviewRelease;
    };

function releaseFailure(error: unknown, status: number): ReviewMetadataState {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : error && typeof error === 'object' && 'value' in error && error.value && typeof error.value === 'object'
        ? 'code' in error.value
          ? error.value.code
          : undefined
        : undefined;
  return status === 202 || code === 'semantic_not_ready' || code === 'index_not_ready' ? 'preparing' : 'unavailable';
}

async function readRelease(client: KernelClient, authorization: string, digest: string): Promise<ReviewRelease> {
  try {
    const response = await client.definitions.releases({ digest }).get({ headers: { authorization } });
    if (response.error || !response.data)
      return { state: releaseFailure(response.error?.value, response.status), digest };
    return {
      state: 'ready',
      digest,
      metadata: conditionMetadata(response.data.release as Parameters<typeof conditionMetadata>[0]),
    };
  } catch {
    return { state: 'unavailable', digest };
  }
}

function accessFailure(status: number): 'denied' | 'unavailable' {
  return status >= 500 ? 'unavailable' : 'denied';
}

/**
 * Read the private rule only after a current session is prepared. Its accepted metadata is fetched by the exact
 * immutable digest; the active release is presented separately for comparison and never changes the saved rule.
 */
export async function loadSavedFilterReview(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id: string,
): Promise<SavedFilterReviewPage> {
  try {
    if (await prepareSession(request, sessionEnv)) return { state: 'denied' };
    const authorization = viewerCredential(request);
    const viewerId = sessionSubject(request);
    if (!authorization || !viewerId) return { state: 'denied' };

    const ruleResponse = await client.collections({ collectionId: id }).rule.get({ headers: { authorization } });
    if (ruleResponse.error || !ruleResponse.data) return { state: accessFailure(ruleResponse.status) };
    const collectionResponse = await client.collections({ collectionId: id }).get({ headers: { authorization } });
    if (collectionResponse.error || !collectionResponse.data)
      return { state: accessFailure(collectionResponse.status) };

    const collection = collectionResponse.data.collection;
    if (
      collection.membershipKind !== 'dynamic' ||
      ('builtinKind' in collection && collection.builtinKind) ||
      collection.curatorAccountId !== viewerId
    )
      return { state: 'denied' };

    const rule = ruleResponse.data.rule;
    const savedRule: SavedRule = { ...rule, filter: parseFilter(rule.filter) };
    let current: ReviewRelease;
    try {
      const active = await client.definitions.active.get({ headers: { authorization } });
      if (active.error || !active.data) {
        current = { state: releaseFailure(active.error?.value, active.status) };
      } else {
        current = await readRelease(client, authorization, active.data.digest);
      }
    } catch {
      current = { state: 'unavailable' };
    }

    const accepted =
      current.digest === savedRule.releaseDigest
        ? current
        : await readRelease(client, authorization, savedRule.releaseDigest);

    return {
      state: 'ready',
      id,
      viewerId,
      title: collection.title ?? id,
      rule: savedRule,
      accepted,
      current,
    };
  } catch {
    return { state: 'unavailable' };
  }
}

export const readSavedFilterReview = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Invalid Collection');
    return value;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadSavedFilterReview(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
