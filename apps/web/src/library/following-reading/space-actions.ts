import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { kernelClient, requestLocale } from '../../kernel/client';
import { readAdmitted, operationIsAdmitted } from '../../kernel/exposure';
import type { SessionEnv } from '../../session/client';
import { locales } from '../../paraglide/runtime.js';
import { readSelectedSpace, type SpaceRead } from './space-reader';

const input = v.strictObject({
  spaceId: v.pipe(v.string(), v.uuid()),
  subject: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  locale: v.picklist(locales),
});
export const readFollowingSpace = createServerFn({ method: 'GET' })
  .validator((value: unknown) => v.parse(input, value))
  .handler(async ({ data }): Promise<SpaceRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const unavailable: SpaceRead = { ...data, result: { state: 'unavailable' } };
    if ((requestLocale(request) ?? 'en') !== data.locale) return unavailable;
    return readSelectedSpace(kernelClient(), request, env as Partial<SessionEnv>, data, async (authorization) =>
      operationIsAdmitted('follow.list', await readAdmitted(authorization)),
    );
  });
