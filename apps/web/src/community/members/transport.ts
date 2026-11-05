import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { validateRealmMembersRead } from './native';
import { readRealmMembersRequest } from './request';

/** Deliberate private browser read, outside route loaders and query hydration. */
export const readRealmMembers = createServerFn({ method: 'POST' })
  .validator(validateRealmMembersRead)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    return readRealmMembersRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient());
  });
