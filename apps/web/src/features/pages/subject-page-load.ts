import type { KernelClient } from '@rezics/client';
import {
  planReads,
  platformRegistry,
  type CompositionDocument,
  type PageContinuation,
  type View,
} from '@rezics/composition';
import { requestLanguages } from '../../kernel/languages';
import { cataloguePageBody, PageReadError, pageReadError, type NativePageBody } from './page-read-failure';
import { assertSubjectPageReadActive, type SubjectPageReadLifetime } from './subject-page-read-lifetime';
import { accountOf } from './account-profile-reading';
import { readTermsPageAuthority, selectSubjectPageProfiles } from './subject-page-application';
import { pageContext, type SubjectPageData } from './page-model';
import { subjectBody } from './subject-read';
import { isRecord } from './shared';

export { PageReadError, pageReadError } from './page-read-failure';

const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SubjectPageLoad =
  | { kind: 'missing' }
  | { kind: 'redirect'; id: string; target?: 'account' }
  | { kind: 'page'; page: SubjectPageData };

/** One `pages.read` of the overview, or of the named view. A merged subject names its survivor; an unknown one is missing. */
export async function loadSubjectPage(
  client: KernelClient,
  id: string,
  view?: View,
  locale = 'en',
  options: {
    realm?: string | undefined;
    board?: string | undefined;
    continuation?: PageContinuation | undefined;
    stream?: string | undefined;
    authorization?: string | undefined;
    signal?: SubjectPageReadLifetime | undefined;
  } = {},
): Promise<SubjectPageLoad> {
  assertSubjectPageReadActive(options.signal);
  if (!subjectIdPattern.test(id)) return { kind: 'missing' };
  let result: Awaited<ReturnType<typeof client.pages.$read.post>>;
  try {
    result = await client.pages.$read.post(
      {
        target: {
          subject: id,
          ...(view ? { view } : {}),
          ...(options.realm ? { realm: options.realm } : {}),
          ...(options.board ? { board: options.board } : {}),
        },
        ...(options.continuation ? { continuation: options.continuation } : {}),
        ...(options.stream ? { stream: options.stream } : {}),
        languages: requestLanguages(locale),
      },
      {
        fetch: { redirect: 'manual', ...(options.signal ? { signal: options.signal } : {}) },
        ...(options.authorization ? { headers: { authorization: options.authorization } } : {}),
      },
    );
  } catch (error) {
    assertSubjectPageReadActive(options.signal);
    if (error instanceof TypeError) throw new PageReadError('dependency_unavailable', 503, '1');
    throw error;
  }
  assertSubjectPageReadActive(options.signal);
  if (result.status === 404) return { kind: 'missing' };
  if (result.status === 308) {
    const body = result.data ?? result.error?.value;
    // A merged subject names its survivor id; a moved account names its handle.
    if (isRecord(body) && 'redirect' in body && isRecord(body.redirect) && typeof body.redirect.to === 'string')
      return subjectIdPattern.test(body.redirect.to)
        ? { kind: 'redirect', id: body.redirect.to }
        : { kind: 'redirect', id: body.redirect.to, target: 'account' };
  }
  if (result.status === 200 && result.data) {
    const native = result.data as NativePageBody;
    if (typeof native.account === 'string') {
      const raw = {
        ...cataloguePageBody(native),
        account: { id: native.account, handle: '' },
      } as SubjectPageData;
      const reads = planReads(platformRegistry, raw.document as CompositionDocument, pageContext(raw)).reads;
      for (const [key, read] of Object.entries(reads)) {
        if (read.kind !== 'account' || raw.reads[key]?.status !== 200) continue;
        // Account descriptors select by handle, which this envelope does not carry.
        // The native profile's immutable ID binds the planned slot to the admitted account.
        const profile = accountOf(raw.reads[key]?.body);
        if (profile?.id === native.account && subjectIdPattern.test(profile.id) && profile.handle)
          return { kind: 'redirect', id: profile.handle, target: 'account' };
      }
      // An absent, handleless or foreign profile supplies no admitted public @ address.
      const catalogue = cataloguePageBody(native);
      if (catalogue.subject !== id || (options.realm && !catalogue.context))
        throw new PageReadError('dependency_unavailable', 503);
      return {
        kind: 'page',
        page: {
          ...catalogue,
          subject: id,
          ...(options.realm ? { requestedRealm: options.realm } : {}),
          ...(options.board ? { board: options.board, requestedBoard: options.board } : {}),
        },
      };
    }
    const survivor = native.subject;
    if (typeof survivor === 'string' && survivor !== id) return { kind: 'redirect', id: survivor };
    if (options.realm && !native.context) throw new PageReadError('dependency_unavailable', 503);
    const page = cataloguePageBody(native);
    // Read the existing mounted Terms authority resource once, alongside this page reading.
    // An advice outage must never fail or conceal the admitted public page.
    const currentPage = page as SubjectPageData;
    const reading = subjectBody(currentPage);
    const eligible =
      reading &&
      currentPage.catalogue?.state === 'released' &&
      selectSubjectPageProfiles({
        type: reading.subject.type,
        definitions: currentPage.catalogue.definitions,
      }).releasedWorkNames;
    let termsAuthority;
    if (eligible) {
      assertSubjectPageReadActive(options.signal);
      termsAuthority = await readTermsPageAuthority(
        client,
        options.authorization ? 'signed-in' : 'signed-out',
        options.authorization,
        options.signal,
      );
      assertSubjectPageReadActive(options.signal);
    }
    return {
      kind: 'page',
      page: {
        ...page,
        subject: page.subject ?? null,
        ...(options.realm ? { requestedRealm: options.realm } : {}),
        ...(options.board ? { board: options.board, requestedBoard: options.board } : {}),
        ...(termsAuthority ? { termsAuthority } : {}),
      },
    };
  }
  throw pageReadError(result.error?.value ?? result.data, result.status, result.headers);
}
