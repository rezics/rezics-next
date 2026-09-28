'use server';

import { redirect } from 'next/navigation';
import { getTranslation, requestLocale } from '../../i18n/server.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { mainApi } from '../api/main.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { signInPath } from '../auth/paths.ts';
import { readSession } from '../auth/session.ts';
import { studioHref, workHref } from './agent.ts';
import type { NewWorkState } from './new-work-form.tsx';
import { idOf, type WorkType, workTypes } from './types.ts';

const idempotencyKey = /^[A-Za-z0-9:_./-]{1,128}$/;
const language = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/i;

/** The Studio Agent a form names, if this person may act as it. Access admits it again for the command. */
async function studioAgent(form: FormData): Promise<AgentOption> {
  const locale = await requestLocale();
  const session = await readSession();
  if (!session) redirect(signInPath(localizedPath('/studio', locale)));
  const named = String(form.get('agent') ?? '');
  const agent = session.agents.find(option => option.iri === named);
  if (!agent) redirect(localizedPath('/studio', locale));
  return agent;
}

export async function createWork(previous: NewWorkState, form: FormData): Promise<NewWorkState> {
  const locale = await requestLocale();
  const { data: t } = await getTranslation('studio', [locale]);
  const title = String(form.get('title') ?? '').trim();
  const type = String(form.get('type') ?? '') as WorkType;
  const writing = String(form.get('language') ?? '');
  // A retry of a pending creation reuses its key, so Main answers with the same Work.
  const key = previous.status === 'pending' ? previous.key : String(form.get('key') ?? '');
  const values = { title, type, language: writing };
  if (!title || title.length > 200) return { status: 'error', message: t.titleError, key, values };
  if (!Object.hasOwn(workTypes, type) || !language.test(writing) || !idempotencyKey.test(key)) {
    return { status: 'error', message: t.createUnavailable, key, values };
  }
  const agent = await studioAgent(form);
  const main = await mainApi();
  // The Studio Agent writes this Work: Main records it as the Work's author.
  const response = await main.v1.works.post({ profile: 'metadata-only-v1', title, language: writing,
    semanticTypes: [workTypes[type]], authoring: 'own-work',
    actingSubject: agent.iri }, { headers: { 'idempotency-key': key } });
  if (response.error) {
    const denied = response.error.status === 401 || response.error.status === 403;
    return { status: 'error', message: denied ? t.createDenied : t.createUnavailable, key: crypto.randomUUID(), values };
  }
  if (!response.data || 'operationId' in response.data) return { status: 'pending', message: t.createPending, key, values };
  // A book is written chapter by chapter; anything else starts on its text.
  redirect(localizedPath(type === 'book' ? workHref(agent, response.data.work, 'chapters')
    : `${studioHref(agent, `/works/${idOf(response.data.work)}/write`)}?language=${encodeURIComponent(writing)}`, locale));
}
