'use server';

import { redirect } from 'next/navigation';
import { getTranslation, requestLocale } from '../../i18n/server.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { mainApi } from '../api/main.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { signInPath } from '../auth/paths.ts';
import { readSession } from '../auth/session.ts';
import { studioHref } from './agent.ts';
import type { DetailsEntry, DetailsState } from './details-form.tsx';
import type { NewWorkState } from './new-work-form.tsx';
import { idOf, type WorkType, workTypes } from './types.ts';

const idempotencyKey = /^[A-Za-z0-9:_./-]{1,128}$/;
const language = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/i;
const workId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  const response = await main.v1.works.post({ profile: 'metadata-only-v1', title, semanticTypes: [workTypes[type]],
    actingSubject: agent.iri }, { headers: { 'idempotency-key': key } });
  if (response.error) {
    const denied = response.error.status === 401 || response.error.status === 403;
    return { status: 'error', message: denied ? t.createDenied : t.createUnavailable, key: crypto.randomUUID(), values };
  }
  if (!response.data || 'operationId' in response.data) return { status: 'pending', message: t.createPending, key, values };
  redirect(localizedPath(`${studioHref(agent, `/works/${idOf(response.data.work)}/write`)}?language=${
    encodeURIComponent(writing)}`, locale));
}

function entries(form: FormData): DetailsEntry[] {
  const languages = form.getAll('entryLanguage').map(String);
  const titles = form.getAll('entryTitle').map(String);
  const descriptions = form.getAll('entryDescription').map(String);
  return languages.map((entry, index) => ({ language: entry.trim(), title: titles[index]?.trim() ?? '',
    description: descriptions[index]?.trim() ?? '' }));
}

export async function saveDetails(previous: DetailsState, form: FormData): Promise<DetailsState> {
  const locale = await requestLocale();
  const { data: t } = await getTranslation('studio', [locale]);
  const work = String(form.get('work') ?? '');
  const expected = String(form.get('expectedHead') ?? '');
  const originalTitle = String(form.get('originalTitle') ?? '').trim();
  const originalLanguage = String(form.get('originalLanguage') ?? '').trim();
  const localized = entries(form).filter(entry => entry.language || entry.title || entry.description);
  const values = { originalTitle, originalLanguage, entries: localized };
  const base = { head: previous.head, values };
  if (!workId.test(work) || (expected && !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(expected))
    || localized.some(entry => !language.test(entry.language) || (!entry.title && !entry.description))
    || new Set(localized.map(entry => entry.language.toLowerCase())).size !== localized.length
    || (originalTitle && !language.test(originalLanguage))) {
    return { ...base, status: 'error', message: t.detailsInvalid };
  }
  const agent = await studioAgent(form);
  const main = await mainApi();
  const response = await main.v1.works({ id: work }).metadata.put({ profile: 'work-metadata-details-v1',
    expectedHead: expected || null, actingSubject: agent.iri, state: { kind: 'header',
      originalTitle: originalTitle ? { value: originalTitle, language: originalLanguage } : null,
      localized: localized.map(entry => ({ language: entry.language, title: entry.title || null,
        description: entry.description || null, mainVersionLabel: null })) } },
  { headers: { 'idempotency-key': crypto.randomUUID() } });
  if (response.data && 'revision' in response.data) {
    return { status: 'saved', message: t.detailsSaved, head: response.data.revision, values };
  }
  if (response.data) return { ...base, status: 'error', message: t.detailsFailed };
  const status = response.error?.status ?? 503;
  if (status === 401 || status === 403) return { ...base, status: 'denied', message: t.detailsDenied };
  if (status === 400 || status === 422) return { ...base, status: 'error', message: t.detailsInvalid };
  if (status === 409) {
    // Keep the writer's values and move the basis to the head that won, so saving again is an explicit overwrite.
    const current = await main.v1.works({ id: work }).metadata.get({ query: { actingSubject: agent.iri } });
    return current.data ? { status: 'stale', message: t.detailsStale, head: current.data.revision, values,
      theirs: current.data.localized.map(entry => ({ language: entry.language, title: entry.title ?? '',
        description: entry.description ?? '' })) } : { ...base, status: 'error', message: t.detailsFailed };
  }
  return { ...base, status: 'error', message: t.detailsFailed };
}

