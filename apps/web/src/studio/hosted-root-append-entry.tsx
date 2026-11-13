import { useEffect, useState } from 'react';
import { ownDraftNativeReader } from '../threads';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { HostedOwnedBook } from './hosted-contract';
import { hostedRootAppendNative } from './hosted-actions';
import { HostedDraftPicker } from './hosted-draft-picker';
import { createPostDocumentPort } from './post-document-port';
import { HostedRootAppendVisit } from './hosted-root-append';
import { HostedRootAppendView } from './hosted-root-append-view';

type Props = {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource | null;
  accountId: string | null | undefined;
  csrfToken: string | null;
  locale: Locale;
};

/** Route composition owns the private lifetime; it never opens the Book Post or complete outline. */
export function HostedRootAppendEntry(props: Props) {
  const { owner, source, accountId, csrfToken, locale } = props;
  const [mounted, setMounted] = useState<{ props: Props; visit: HostedRootAppendVisit } | null>(null);
  useEffect(() => {
    if (!source || !accountId || !csrfToken || owner.viewer.accountId !== accountId) return;
    let visit: HostedRootAppendVisit;
    let picker: HostedDraftPicker;
    const documents = createPostDocumentPort({
      projectId: owner.item.catalogueId,
      accountId,
      locale,
      source,
      csrfToken,
      isCurrent: () => visit?.isCurrent() ?? true,
      admitsPost: (postId) => picker.admitsPost(postId),
    });
    picker = new HostedDraftPicker({
      viewer: owner.viewer,
      source,
      reader: ownDraftNativeReader,
      locale,
      isCurrent: () => visit?.isCurrent() ?? true,
      readDocument: (postId, signal) => documents.open({ projectId: owner.item.catalogueId, postId }, signal),
    });
    visit = new HostedRootAppendVisit({ owner, source, locale, csrfToken, picker, native: hostedRootAppendNative });
    setMounted({ props, visit });
    const state = visit.snapshot();
    if (state.kind === 'active') void state.outline.load();
    return visit.dispose;
  }, [owner, source, accountId, csrfToken, locale]);
  if (
    mounted &&
    mounted.props.owner === owner &&
    mounted.props.source === source &&
    mounted.props.accountId === accountId &&
    mounted.props.csrfToken === csrfToken &&
    mounted.props.locale === locale
  )
    return <HostedRootAppendView visit={mounted.visit} locale={locale} />;
  return <p role="status">{m.studio_root_append_loading({}, { locale })}</p>;
}
