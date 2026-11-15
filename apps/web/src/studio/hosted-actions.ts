import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { m } from '../paraglide/messages.js';
import { getLocale, locales, type Locale } from '../paraglide/runtime.js';
import { hasKernelOrigin, kernelClient } from '../kernel/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import type { StudioResult } from './contract';
import {
  hostedCreate,
  hostedDraftPointRequest,
  hostedPublicationPointRequest,
  type HostedPublicationPointNative,
  type HostedDraftPointNative,
  hostedId,
  hostedHistoryRequest,
  hostedOwnerBinding,
  hostedOwnerViewer,
  hostedKey,
  hostedPublish,
  hostedRevise,
  hostedBindLanguage,
  hostedSelection,
  hostedOutlineWindowRequest,
  hostedRootAppendRequest,
  type HostedRootAppendNative,
  type HostedOutlineWindowNative,
  type HostedBook,
  type HostedBookNative,
} from './hosted-contract';
import { createHostedBookNative, hostedFailure } from './hosted-native';

const uiLocale = v.optional(v.picklist(locales));

async function admitted(
  locale: Locale | undefined,
  run: (native: HostedBookNative, signal: AbortSignal) => Promise<StudioResult<HostedBook>>,
  mutation = false,
): Promise<StudioResult<HostedBook>> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const options = { locale: locale ?? getLocale() };
  try {
    // This is also the existing Origin/CSRF boundary for server-function commands.
    await prepareSession(request, env as Partial<SessionEnv>);
    const credential = viewerCredential(request);
    if (!credential) return hostedFailure('denied', m.studio_sign_in({}, options));
    if (!hasKernelOrigin()) return hostedFailure('unavailable', m.studio_books_service_unavailable({}, options));
    return await run(createHostedBookNative(kernelClient(options.locale, credential), options.locale), request.signal);
  } catch {
    return hostedFailure(
      mutation ? 'uncertain' : 'unavailable',
      mutation ? m.studio_result_unknown({}, options) : m.studio_workspace_unavailable({}, options),
    );
  }
}

export const readHostedBook = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(v.strictObject({ ...hostedSelection.entries, locale: uiLocale }), input))
  .handler(({ data: { locale, ...selection } }) => admitted(locale, (native, signal) => native.read(selection, signal)));

export const createHostedBook = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(v.strictObject({ body: hostedCreate, idempotencyKey: hostedKey, locale: uiLocale }), input))
  .handler(({ data }) => admitted(data.locale, (native, signal) => native.create(data.body, data.idempotencyKey, signal), true));

export const reviseHostedBook = createServerFn({ method: 'POST' })
  .validator((input: unknown) =>
    v.parse(
      v.strictObject({
        catalogueId: hostedId,
        body: hostedRevise,
        idempotencyKey: hostedKey,
        locale: uiLocale,
      }),
      input,
    ),
  )
  .handler(({ data }) =>
    admitted(data.locale, (native, signal) => native.revise(data.catalogueId, data.body, data.idempotencyKey, signal), true),
  );

export const bindHostedChapterLanguage = createServerFn({ method: 'POST' })
  .validator((input: unknown) =>
    v.parse(
      v.strictObject({
        catalogueId: hostedId,
        occurrenceId: hostedId,
        body: hostedBindLanguage,
        idempotencyKey: hostedKey,
        locale: uiLocale,
      }),
      input,
    ),
  )
  .handler(({ data }) =>
    admitted(
      data.locale,
      (native, signal) =>
        native.bindLanguage
          ? native.bindLanguage(data.catalogueId, data.occurrenceId, data.body, data.idempotencyKey, signal)
          : Promise.resolve(hostedFailure('unavailable', 'Chapter language association is unavailable.')),
      true,
    ),
  );

export const publishHostedBook = createServerFn({ method: 'POST' })
  .validator((input: unknown) =>
    v.parse(
      v.strictObject({
        catalogueId: hostedId,
        body: hostedPublish,
        idempotencyKey: hostedKey,
        locale: uiLocale,
      }),
      input,
    ),
  )
  .handler(({ data }) =>
    admitted(data.locale, (native, signal) => native.publish(data.catalogueId, data.body, data.idempotencyKey, signal), true),
  );

async function admittedOwner<T>(
  locale: Locale | undefined,
  run: (
    native: HostedBookNative &
      HostedOutlineWindowNative &
      HostedRootAppendNative &
      HostedDraftPointNative &
      HostedPublicationPointNative,
    accountId: string,
    signal: AbortSignal,
  ) => Promise<StudioResult<T>>,
  mutation = false,
): Promise<StudioResult<T>> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  const options = { locale: locale ?? getLocale() };
  try {
    await prepareSession(request, env as Partial<SessionEnv>);
    const accountId = sessionSubject(request);
    const credential = viewerCredential(request);
    if (!accountId || !credential) return hostedFailure('denied', m.studio_sign_in({}, options));
    if (!hasKernelOrigin()) return hostedFailure('unavailable', m.studio_books_service_unavailable({}, options));
    return await run(createHostedBookNative(kernelClient(options.locale, credential), options.locale), accountId, request.signal);
  } catch {
    return hostedFailure(
      mutation ? 'uncertain' : 'unavailable',
      mutation ? m.studio_result_unknown({}, options) : m.studio_workspace_unavailable({}, options),
    );
  }
}

const ownerInventoryRequest = v.strictObject({
  accountId: v.optional(hostedId),
  locale: uiLocale,
  expected: v.optional(hostedOwnerBinding),
  cursor: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
export const listHostedBooks = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(ownerInventoryRequest, input))
  .handler(({ data }) =>
    admittedOwner(data.locale, (native, accountId, signal) =>
      data.accountId && data.accountId !== accountId
        ? Promise.resolve(hostedFailure('denied', m.studio_inventory_account({}, { locale: data.locale ?? getLocale() })))
        : native.listOwn(accountId, data.cursor, signal, data.expected),
    ),
  );

/** History discovery is always an authenticated author action, even for a public release. */
export const listHostedBookHistory = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(hostedHistoryRequest, input))
  .handler(({ data }) =>
    admittedOwner(undefined, (native, _accountId, signal) => native.listHistory(data.catalogueId, data.cursor, signal)),
  );

/** Exact author-only page; authentication is required even when the selected release is public. */
export const readHostedOutlineWindow = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(hostedOutlineWindowRequest, input))
  .handler(({ data }) => admittedOwner(undefined, (native, _accountId, signal) => native.readOutlineWindow(data, signal)));

export const hostedOutlineWindowNative: HostedOutlineWindowNative = {
  async readOutlineWindow(data, signal) {
    try {
      return await readHostedOutlineWindow({ data, signal });
    } catch {
      return hostedFailure('unavailable', 'This exact outline page could not be read. Retry this page.');
    }
  },
};

export const writeHostedDraftPoint = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(hostedDraftPointRequest, input))
  .handler(({ data }) =>
    admittedOwner(undefined, async (native, accountId, signal) => {
      if (data.expectedViewer.accountId !== accountId)
        return hostedFailure('denied', 'This book belongs to a different account.');
      const owner = await native.readOwn(accountId, data.catalogueId, signal, data.expectedViewer);
      if (!owner.ok) return owner;
      return native.writeDraftPoint(data, signal);
    }, true),
  );

export const readHostedMetadata = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(hostedSelection, input))
  .handler(({ data }) => admittedOwner(undefined, (native, _accountId, signal) => native.readMetadata(data, signal)));

export const writeHostedPublicationPoint = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(hostedPublicationPointRequest, input))
  .handler(({ data }) =>
    admittedOwner(undefined, async (native, accountId, signal) => {
      if (data.expectedViewer.accountId !== accountId)
        return hostedFailure('denied', 'This Book belongs to a different account.');
      const owner = await native.readOwn(accountId, data.catalogueId, signal, data.expectedViewer);
      if (!owner.ok) return owner;
      return native.writePublicationPoint(data, signal);
    }, true),
  );

export const hostedPublicationPointNative: HostedPublicationPointNative & Pick<HostedBookNative, 'readOwn'> = {
  ...hostedOutlineWindowNative,
  readOwn: (...args) => hostedRootAppendNative.readOwn(...args),
  async readMetadata(data, signal) {
    try {
      return await readHostedMetadata({ data, signal });
    } catch {
      return hostedFailure('unavailable', 'This exact Book metadata could not be read. Retry reading.');
    }
  },
  async writePublicationPoint(data, signal, csrfToken) {
    try {
      return await writeHostedPublicationPoint({ data, signal, headers: { 'X-CSRF-Token': csrfToken! } });
    } catch {
      return hostedFailure('uncertain', 'The command result is unknown. Retry the same operation.');
    }
  },
};

export const appendHostedRootChapter = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(hostedRootAppendRequest, input))
  .handler(({ data }) =>
    admittedOwner(undefined, async (native, accountId, signal) => {
      if (data.expectedViewer.accountId !== accountId)
        return hostedFailure('denied', 'This book belongs to a different account.');
      const owner = await native.readOwn(accountId, data.catalogueId, signal, data.expectedViewer);
      if (!owner.ok) return owner;
      return native.appendRootChapter(data, signal);
    }, true),
  );

export const hostedRootAppendNative: HostedRootAppendNative &
  HostedOutlineWindowNative &
  Pick<HostedBookNative, 'readOwn'> = {
  ...hostedOutlineWindowNative,
  async readOwn(accountId, catalogueId, signal, expectedViewer) {
    try {
      return await readOwnedHostedBook({ data: { accountId, catalogueId, expectedViewer, locale: getLocale() }, signal });
    } catch {
      return hostedFailure('unavailable', 'The current Book head could not be read. Retry the refresh.');
    }
  },
  async appendRootChapter(data, signal, csrfToken) {
    try {
      return await appendHostedRootChapter({ data, signal, headers: { 'X-CSRF-Token': csrfToken! } });
    } catch {
      return hostedFailure('uncertain', 'The command result is unknown. Retry the same operation.');
    }
  },
};

export const hostedDraftPointNative: HostedDraftPointNative &
  HostedOutlineWindowNative &
  Pick<HostedBookNative, 'readOwn'> = {
  ...hostedOutlineWindowNative,
  readOwn: (...args) => hostedRootAppendNative.readOwn(...args),
  async writeDraftPoint(data, signal, csrfToken) {
    try {
      return await writeHostedDraftPoint({ data, signal, headers: { 'X-CSRF-Token': csrfToken! } });
    } catch {
      return hostedFailure('uncertain', 'The command result is unknown. Retry the same operation.');
    }
  },
};

export const readOwnedHostedBook = createServerFn({ method: 'GET' })
  .validator((input: unknown) =>
    v.parse(
      v.strictObject({
        accountId: v.optional(hostedId),
        catalogueId: hostedId,
        expectedViewer: v.optional(hostedOwnerViewer),
        locale: uiLocale,
      }),
      input,
    ),
  )
  .handler(({ data }) =>
    admittedOwner(data.locale, (native, accountId, signal) =>
      data.accountId && data.accountId !== accountId
        ? Promise.resolve(hostedFailure('denied', m.studio_book_account({}, { locale: data.locale ?? getLocale() })))
        : native.readOwn(accountId, data.catalogueId, signal, data.expectedViewer),
    ),
  );

/** Browser callers receive admitted data only. Credentials remain inside the ordinary BFF session boundary. */
export const hostedBookNative: HostedBookNative = {
  listHistory: (catalogueId, cursor, signal) => listHostedBookHistory({ data: { catalogueId, cursor }, signal }),
  read: (data, signal) => readHostedBook({ data: { ...data, locale: getLocale() }, signal }),
  listOwn: (accountId, cursor, signal, expected) => listHostedBooks({ data: { accountId, cursor, expected, locale: getLocale() }, signal }),
  readOwn: (accountId, catalogueId, signal, expectedViewer) =>
    readOwnedHostedBook({ data: { accountId, catalogueId, expectedViewer, locale: getLocale() }, signal }),
  create: (body, idempotencyKey, signal) => createHostedBook({ data: { body, idempotencyKey, locale: getLocale() }, signal }),
  bindLanguage: (catalogueId, occurrenceId, body, idempotencyKey, signal) =>
    bindHostedChapterLanguage({ data: { catalogueId, occurrenceId, body, idempotencyKey, locale: getLocale() }, signal }),
  revise: (catalogueId, body, idempotencyKey, signal) =>
    reviseHostedBook({ data: { catalogueId, body, idempotencyKey, locale: getLocale() }, signal }),
  publish: (catalogueId, body, idempotencyKey, signal) =>
    publishHostedBook({ data: { catalogueId, body, idempotencyKey, locale: getLocale() }, signal }),
};
