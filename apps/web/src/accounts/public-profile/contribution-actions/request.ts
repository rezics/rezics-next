import type { KernelClient } from '@rezics/client';
import type { ContributionActionsInput } from './receiver';
import { validateContributionActionsResponse } from './response';

/** The private transport uses precisely the installed selected-read callable, with no frontier reread. */
export async function readInstalledContributionActions(
  client: KernelClient,
  input: ContributionActionsInput,
  authorization: string | null,
  signal: AbortSignal,
) {
  const { accountId, references, ...body } = input;
  const result = await client.accounts({ id: accountId })['contribution-actions'].post(
    { ...body, references: [...references] },
    { ...(authorization ? { headers: { authorization } } : {}), fetch: { cache: 'no-store', signal } },
  );
  if (result.status !== 200 || result.error || !result.data) throw new Error('Author contribution actions read failed');
  return validateContributionActionsResponse(input, result.data);
}
