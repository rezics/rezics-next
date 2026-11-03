import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { requestLocale } from '../../kernel/client';
import { readRelease } from '../../subject/definitions';
import type { SessionEnv } from '../../session/client';
import { copiesSubjectId } from '../copies-query';
import { loadProgressSession, type ProgressSessionPage } from '../progress-reads';
import { loadConfiguredLibraryVisit, type ConfiguredLibraryVisit, type ConfiguredVisitInput } from './visit';

function visitInput(input: unknown): ConfiguredVisitInput {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const subjectId = typeof record.subjectId === 'string' ? record.subjectId : '';
  const type = typeof record.type === 'string' ? record.type : '';
  const locale = typeof record.locale === 'string' ? record.locale : 'en';
  const copyCursor = typeof record.copyCursor === 'string' ? record.copyCursor : undefined;
  const sessionCursor = typeof record.sessionCursor === 'string' ? record.sessionCursor : undefined;
  return {
    subjectId,
    type,
    locale,
    ...(copyCursor === undefined ? {} : { copyCursor }),
    ...(sessionCursor === undefined ? {} : { sessionCursor }),
  };
}

/** Authenticated BFF visit: profile plus addressed entry, one sessions page and one copies page. */
export const readConfiguredLibraryVisit = createServerFn({ method: 'GET' })
  .validator(visitInput)
  .handler(async ({ data }): Promise<ConfiguredLibraryVisit> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const locale = requestLocale(request) ?? data.locale;
    const release = await readRelease().catch(() => undefined);
    return loadConfiguredLibraryVisit(
      kernelClient(),
      request,
      env as Partial<SessionEnv>,
      { ...data, locale },
      release,
    );
  });

function historyInput(input: unknown): { id: string; changes?: string } {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const id = typeof record.id === 'string' ? record.id : '';
  const changes = typeof record.changes === 'string' ? record.changes : undefined;
  return { id, ...(changes === undefined ? {} : { changes }) };
}

/** One bounded progress-change page for the selected session. Independent of the owner's other history. */
export const readConfiguredProgressHistory = createServerFn({ method: 'GET' })
  .validator(historyInput)
  .handler(async ({ data }): Promise<ProgressSessionPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadProgressSession(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export function configuredVisitAddress(input: ConfiguredVisitInput) {
  return {
    subjectId: copiesSubjectId(input.subjectId) ?? input.subjectId,
    type: input.type,
    locale: input.locale,
    copyCursor: input.copyCursor ?? null,
    sessionCursor: input.sessionCursor ?? null,
  };
}
