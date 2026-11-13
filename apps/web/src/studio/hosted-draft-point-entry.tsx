import { useEffect, useState } from 'react';
import { ownDraftNativeReader } from '../threads';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { HostedOwnedBook } from './hosted-contract';
import { hostedDraftPointNative } from './hosted-actions';
import { HostedDraftPicker } from './hosted-draft-picker';
import { createPostDocumentPort } from './post-document-port';
import { HostedDraftPointVisit } from './hosted-draft-points';
import { HostedDraftPointView } from './hosted-draft-point-view';

type Props = {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource | null;
  accountId: string | null | undefined;
  csrfToken: string | null;
  locale: Locale;
};

/** Owned Book route boundary; changes retire the private visit before its replacement is rendered. */
export function HostedDraftPointEntry(props: Props) {
  const { owner, source, accountId, csrfToken, locale } = props;
  const [mounted, setMounted] = useState<{ props: Props; visit: HostedDraftPointVisit } | null>(null);
  useEffect(() => {
    if (!source || !accountId || !csrfToken || owner.viewer.accountId !== accountId) return;
    let visit: HostedDraftPointVisit;
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
    visit = new HostedDraftPointVisit({
      owner,
      source,
      locale,
      csrfToken,
      picker,
      native: hostedDraftPointNative,
      readVersion: (selection, signal) =>
        documents.revision({ projectId: owner.item.catalogueId, document: selection.revision.exact }, signal),
    });
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
    return <HostedDraftPointView visit={mounted.visit} locale={locale} />;
  return <p role="status">{m.studio_draft_point_loading({}, { locale })}</p>;
}
