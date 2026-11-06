import * as v from 'valibot';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  profileControlFlow,
  profileSaveSetupFailure,
  serializeProfileResult,
  withProfileDeadline,
} from '../../settings/preferences';
import { parseSubmission, readTarget, selection, writeTarget, type Selection, type ProfilePage } from './data';
import { boundViewer } from './request';

async function viewer(target: Selection) {
  setResponseHeader('cache-control', 'private, no-store');
  const authorization = await boundViewer(getRequest(), env as Partial<SessionEnv>, target.viewerId);
  if (!authorization) return null;
  if (!(env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN) throw new Error('KERNEL_ORIGIN unavailable');
  return authorization;
}
export const readAccountProfile = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(selection, input))
  .handler(async ({ data }): Promise<ProfilePage> => {
    try {
      const authorization = await viewer(data);
      return serializeProfileResult(
        authorization
          ? await readTarget(kernelClient(), authorization, data, getRequest().signal)
          : { state: 'signed-out' as const },
      );
    } catch (error) {
      profileControlFlow(error);
      return { state: 'unavailable' };
    }
  });
export const saveAccountProfile = createServerFn({ method: 'POST' })
  .validator(parseSubmission)
  .handler(async ({ data }) => {
    try {
      // prepareSession checks Origin and the current session's CSRF identity before native I/O.
      const authorization = await viewer(data);
      return serializeProfileResult(
        authorization
          ? await withProfileDeadline(
              (signal) => writeTarget(kernelClient(), authorization, data, signal),
              getRequest().signal,
            )
          : { ok: false as const, status: 403, message: '' },
      );
    } catch (error) {
      return profileSaveSetupFailure(error);
    }
  });
