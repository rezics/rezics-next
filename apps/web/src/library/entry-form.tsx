import type { KernelClient } from '@rezics/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { locales } from '../paraglide/runtime.js';
import { paraglideMiddleware } from '../paraglide/server.js';
import { m } from '../paraglide/messages.js';
import { problem, problemResponse } from '../media/kernel';
import {
  removePersonalLibraryEntry,
  restorePersonalLibraryEntry,
  validateLibraryRestoreInput,
  type LibraryRestoreInput,
  type LibraryRestoreResult,
} from './entries-read';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from './entry-restore-credential';
import { EntryFormPage } from './entry-undo';

async function boundedForm(request: Request): Promise<URLSearchParams> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded')
    throw problem(400, 'invalid_request', 'Invalid Request');
  const reader = request.body?.getReader();
  if (!reader) throw problem(400, 'invalid_request', 'Invalid Request');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw problem(413, 'invalid_request', 'Invalid Request');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Native document POSTs share the ordinary revisioned writes and session/CSRF validation. */
export async function libraryEntryFormResponse(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  stylesheet?: string,
): Promise<Response> {
  try {
    if (request.method !== 'POST')
      return problemResponse(problem(405, 'invalid_request', 'Invalid Request'), { allow: 'POST' });
    if (await prepareSession(request, sessionEnv)) return problemResponse(problem(403, 'forbidden', 'Forbidden'));
    const authorization = viewerCredential(request);
    if (!authorization) return problemResponse(problem(403, 'forbidden', 'Forbidden'));
    const form = await boundedForm(request);
    const single = (key: string) => (form.getAll(key).length === 1 ? form.get(key)! : '');
    const subjectId = single('subjectId');
    const revision = Number(single('revision'));
    const intent = single('intent');
    const deletionId = single('deletionId');
    const idempotencyKey = single('idempotencyKey');
    const incarnationId = single('incarnationId');
    const credential = form.has('credential') ? single('credential') : undefined;
    if (
      (credential !== undefined &&
        (!/^[A-Za-z0-9_-]{1,3200}$/.test(credential) || form.getAll('credential').length !== 1)) ||
      !subjectId ||
      subjectId.length > 128 ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      (intent !== 'remove' && intent !== 'restore') ||
      (intent === 'restore' && (!deletionId || deletionId.length > 128)) ||
      (incarnationId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(incarnationId)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)
    )
      return problemResponse(problem(400, 'invalid_request', 'Invalid Request'));
    // Group presence grants neither removal nor restore, and Undo cannot gate removal.
    const exposure = await client.platform.exposure.get({
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    const operation = intent === 'remove' ? 'library_entry.delete' : 'library_entry.restore';
    const admitted = exposure.error ? undefined : exposure.data?.admitted;
    if (!admitted?.includes(operation as never))
      return problemResponse(problem(403, 'platform_closed', 'Platform Closed'));
    const locale = locales.find((value) => value === single('locale')) ?? 'en';
    const back = new URL(single('returnTo') || `/${locale}/library`, request.url);
    const returnTo =
      back.origin === new URL(request.url).origin && back.pathname.startsWith(`/${locale}/`)
        ? `${back.pathname}${back.search}`
        : `/${locale}/library`;
    const authorized = new Request(request.url, { method: 'POST', headers: { authorization } });
    let undo: LibraryRestoreInput | undefined;
    let restore: LibraryRestoreResult | undefined;
    let removed = false;
    let conflict = false;
    if (intent === 'restore') {
      const input = validateLibraryRestoreInput({ subjectId, deletionId, revision, idempotencyKey, credential });
      const original = await originalEntryRestoreCredential(request, sessionEnv, input.credential);
      if (!original) return problemResponse(problem(403, 'forbidden', 'Forbidden'));
      restore = await restorePersonalLibraryEntry(
        client,
        new Request(request.url, { method: 'POST', headers: { authorization: original } }),
        {},
        { subjectId, deletionId, revision, idempotencyKey },
      );
      if (!restore.ok && ['unavailable', 'closed', 'signed-out'].includes(restore.reason)) undo = input;
    } else {
      const result = await removePersonalLibraryEntry(
        client,
        authorized,
        {},
        {
          subjectId,
          revision,
          ...(incarnationId ? { incarnationId } : {}),
          idempotencyKey,
        },
      );
      removed = result.ok || result.reason === 'missing';
      if (result.ok && result.undo && admitted.includes('library_entry.restore' as never)) {
        const credential = await captureEntryRestoreCredential(request, sessionEnv);
        undo = {
          subjectId,
          ...result.undo,
          idempotencyKey: result.undo.idempotencyKey ?? crypto.randomUUID(),
          ...(credential ? { credential } : {}),
        };
      } else if (!result.ok && result.reason === 'conflict') {
        conflict = true;
        restore = { ok: true, entry: result.entry };
      } else if (!removed) restore = { ok: false, reason: 'unavailable' };
    }
    const csrfToken = single('csrf_token') || null;
    const queryClient = new QueryClient();
    // Render only the operations observed from the native admission response.
    queryClient.setQueryData(['exposure', 'anonymous'], admitted);
    const context = new Request(new URL(`/${locale}/library`, request.url), { headers: request.headers });
    return await paraglideMiddleware(context, () => {
      const markup = renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <html lang={locale}>
            <head>
              <meta charSet="utf-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1" />
              <title>{m.library_heading()}</title>
              {stylesheet ? <link rel="stylesheet" href={stylesheet} /> : null}
            </head>
            <body>
              <EntryFormPage
                locale={locale}
                undo={undo}
                restore={restore}
                removed={removed}
                conflict={conflict}
                csrfToken={csrfToken}
                returnTo={returnTo}
              />
            </body>
          </html>
        </QueryClientProvider>,
      );
      queryClient.clear();
      return new Response(`<!DOCTYPE html>${markup}`, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'x-robots-tag': 'noindex',
          'content-security-policy': "default-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        },
      });
    });
  } catch (error) {
    return problemResponse(error);
  }
}
