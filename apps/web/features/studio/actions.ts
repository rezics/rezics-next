'use server';

import { redirect } from 'next/navigation';
import { getTranslation, requestLocale } from '../../i18n/server.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { mainApi } from '../api/main.ts';
import { signInPath } from '../auth/paths.ts';
import { readSession } from '../auth/session.ts';
import type { CreateState } from './create-work-form.tsx';

export async function createWork(_previous: CreateState, form: FormData): Promise<CreateState> {
  const locale = await requestLocale();
  const { data: messages } = await getTranslation('studio', [locale]);
  const title = String(form.get('title') ?? '').trim();
  if (!title || title.length > 200) return { status: 'error', message: messages.titleError };
  const session = await readSession();
  if (!session) redirect(signInPath(localizedPath('/studio', locale)));
  // The session Agent is a proposal; Access admits it again for this command.
  if (session.agent.status !== 'selected') redirect(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(localizedPath('/studio', locale))}`);
  const subject = session.agent.agent.iri;
  const main = await mainApi();
  const response = await main.v1.works.post({ profile: 'metadata-only-v1', title, actingSubject: subject },
    { headers: { 'idempotency-key': crypto.randomUUID() } });
  if (response.error) {
    if (response.error.status === 403) return { status: 'error', message: messages.denied };
    return { status: 'error', message: messages.unavailable };
  }
  if (!response.data) return { status: 'error', message: messages.noResult };
  if ('operationId' in response.data) {
    return { status: 'pending', message: messages.pending,
      operationId: response.data.operationId };
  }
  return { status: 'created', title, receipt: response.data };
}
