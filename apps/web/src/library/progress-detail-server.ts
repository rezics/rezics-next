import { progressSessionAddress, progressAddressIssue, ProgressAddressError, type ProgressAddressField } from './progress-address';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { sessionSubject, viewerCredential } from '../session/request';
import { assertPublicCacheReadAllowed } from '../security/page-cache';
import { nameSubjectTypes } from '../subject/definitions';
import { loadProgressSession, type ProgressSessionPage } from './progress-reads';
import { loadMyPublishedLogs, type PublishedLogPage } from './logs-read';
import { progressSubjects } from './progress-subjects';

export type ProgressDetailAddress = { id: string; changes?: string; units?: string; logs?: string };
export type ProgressDetail = { address: ProgressDetailAddress } & (
  | { state: 'refused'; viewer: null }
  | { state: 'invalid'; viewer: null; issue: ProgressAddressField }
  | {
      state: 'ready';
      viewer: string;
      progress: Extract<ProgressSessionPage, { signedIn: true }>;
      logs: PublishedLogPage;
    }
);

/** Each native reader records its own actual preparation on a distinct request. */
export const readProgressDetail = createServerFn({ method: 'GET' })
  .validator(progressSessionAddress)
  .handler(async ({ data }): Promise<ProgressDetail> => {
    setResponseHeader('cache-control', 'private, no-store');
    const issue = progressAddressIssue(data);
    if (issue) return { state: 'invalid', viewer: null, address: data, issue };
    const request = getRequest();
    assertPublicCacheReadAllowed(request, 'session');
    const progressRequest = new Request(request);
    const logsRequest = new Request(request);
    const client = kernelClient();
    const sessionEnv = env as Partial<SessionEnv>;
    let results;
    try { results = await Promise.all([
      loadProgressSession(client, progressRequest, sessionEnv, data),
      loadMyPublishedLogs(client, logsRequest, sessionEnv, data.logs ? { cursor: data.logs } : {}),
    ]); } catch (error) {
      if (error instanceof ProgressAddressError) return { state: 'invalid', viewer: null, address: data, issue: error.field };
      throw error;
    }
    const [progress, logs] = results;
    const viewer = sessionSubject(progressRequest);
    const logsViewer = sessionSubject(logsRequest);
    // Header credentials without an actual session preparation have no owner provenance.
    if (
      !progress.signedIn ||
      !logs.signedIn ||
      !viewer ||
      viewer !== logsViewer ||
      !viewerCredential(progressRequest) ||
      !viewerCredential(logsRequest)
    )
      return { state: 'refused', viewer: null, address: data };
    if (progress.session.id !== data.id) throw notFound();
    await nameSubjectTypes([
      progress.session.subject,
      progress.session.versionSubject,
      ...logs.logs.map((log) => log.subject),
    ]);
    const summaries = progressSubjects(progress, logs);
    if (!summaries.progress.signedIn) throw notFound();
    return { state: 'ready', viewer, address: data, progress: summaries.progress, logs: summaries.logs };
  });
