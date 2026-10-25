import { platformRegistry, validateProfile, type PresentationProfile } from '@rezics/composition';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { curationFailure, publishProfile, type CurationFailure, type PublishInput, type PublishResult } from './curate';

export type CurationRead =
  | { ok: true; digest: string; head: number; profile: PresentationProfile }
  | { ok: false; reason: 'signed-out' }
  | CurationFailure;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i;

function validateInput(input: unknown): PublishInput | CurationFailure {
  if (
    !input ||
    typeof input !== 'object' ||
    !('profile' in input) ||
    !('expectedHead' in input) ||
    !Number.isSafeInteger(input.expectedHead) ||
    (input.expectedHead as number) < 0 ||
    !('keys' in input) ||
    !input.keys ||
    typeof input.keys !== 'object' ||
    !('publish' in input.keys) ||
    typeof input.keys.publish !== 'string' ||
    !uuid.test(input.keys.publish) ||
    !('activate' in input.keys) ||
    typeof input.keys.activate !== 'string' ||
    !uuid.test(input.keys.activate) ||
    input.keys.publish === input.keys.activate
  )
    throw new Error('Invalid curation request');
  const errors = validateProfile(platformRegistry, input.profile);
  if (errors.length > 0) return { ok: false, reason: 'invalid', errors };
  return {
    profile: input.profile as PresentationProfile,
    expectedHead: input.expectedHead as number,
    keys: { publish: input.keys.publish, activate: input.keys.activate },
  };
}

async function sessionBearer() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}

// POST server functions use the site's origin and session-token CSRF middleware.
// Composition props are typed as unknown; validateProfile checks their JSON shape.
export const readCuration = createServerFn({ method: 'POST', strict: false })
  .validator(() => undefined)
  .handler(async (): Promise<CurationRead> => {
    const authorization = await sessionBearer();
    if (!authorization) return { ok: false, reason: 'signed-out' };
    try {
      const client = kernelClient();
      const active = await client.presentation.active.get({ headers: { authorization } });
      if (active.status >= 400) return curationFailure(active.status, active.error?.value, active.headers);
      if (!active.data) return { ok: false, reason: 'unavailable' };
      const result = await client.presentation
        .profiles({ digest: active.data.digest })
        .get({ headers: { authorization } });
      if (result.status >= 400) return curationFailure(result.status, result.error?.value, result.headers);
      if (!result.data || validateProfile(platformRegistry, result.data.profile).length > 0)
        return { ok: false, reason: 'unavailable' };
      return { ok: true, ...active.data, profile: result.data.profile as PresentationProfile };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });

export const publishCuration = createServerFn({ method: 'POST' })
  .validator(validateInput)
  .handler(async ({ data }): Promise<PublishResult> => {
    const authorization = await sessionBearer();
    if (!authorization) return { ok: false, reason: 'forbidden' };
    if ('ok' in data) return data;
    return publishProfile(kernelClient(), { ...data, authorization });
  });
