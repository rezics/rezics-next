import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { createEditableProfileSource } from './editable-profile-source';

export type AccountRenameContext = {
  accountId: string;
  handle: string | null;
  available: boolean;
};

const actionsResponse = v.strictObject({
  resources: v.tuple([
    v.strictObject({
      type: v.literal('access.account'),
      id: v.string(),
      viewerActions: v.array(v.strictObject({ action: v.string(), operations: v.array(v.string()) })),
    }),
  ]),
});

/** One current session read plus the two exact-key reads, independently of preferences. */
export async function loadAccountRenameRegion(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<AccountRenameContext | null> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  return authorization && accountId ? readAccountRenameContext(client, authorization, accountId) : null;
}

/** Two bounded private reads for the session's exact self key; no public handle lookup. */
export async function readAccountRenameContext(
  client: KernelClient,
  authorization: string,
  accountId: string,
): Promise<AccountRenameContext | null> {
  try {
    const [profile, result] = await Promise.all([
      createEditableProfileSource(client).read(authorization, accountId),
      client.viewerActions.post(
        { resources: [{ type: 'access.account', id: accountId }] },
        { headers: { authorization, 'cache-control': 'no-store' }, fetch: { cache: 'no-store' } },
      ),
    ]);
    const parsed = !result.error && result.status === 200 ? v.safeParse(actionsResponse, result.data) : null;
    const resource = parsed?.success ? parsed.output.resources[0] : null;
    return {
      accountId: profile.id,
      handle: profile.handle,
      // Native discovery includes installed operation exposure and the current permission formula.
      available:
        profile.kind === 'actor' &&
        resource?.id === accountId &&
        resource.viewerActions.some(
          (entry) => entry.action === 'account:update' && entry.operations.includes('account.update'),
        ),
    };
  } catch {
    return null;
  }
}
