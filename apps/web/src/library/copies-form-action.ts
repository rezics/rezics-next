import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { removeCopy, saveCopy, submitCopy } from './copies-read';

/** The ordinary HTML form and enhanced editor use the same revisioned write functions. */
export async function postCopyForm(client: KernelClient, request: Request, env: Partial<SessionEnv>) {
  const form = await request.clone().formData();
  const data = Object.fromEntries(form);
  const input = {
    ...data,
    revision: Number(data.revision),
    location: data.location ?? null,
    source: data.source ?? null,
    acquiredOn: data.acquiredOn ?? null,
    disposedOn: data.disposedOn ?? null,
    note: data.note ?? null,
  };
  if (data.intent === 'delete') return removeCopy(client, request, env, input);
  if (data.intent === 'update') return saveCopy(client, request, env, input);
  // A form from an older kernel omits kind. A profiled owner view includes it, including null on historical rows.
  if (data.sendKind === 'false') delete data.kind;
  return submitCopy(client, request, env, { ...input, kind: data.kind });
}
