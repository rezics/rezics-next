import { useEffect, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { ownDraftNativeReader } from '../threads';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import type { HostedOwnedBook } from './hosted-contract';
import { hostedDraftPointNative, hostedPublicationPointNative } from './hosted-actions';
import { HostedDraftPicker } from './hosted-draft-picker';
import { createPostDocumentPort } from './post-document-port';
import { HostedDraftPointVisit } from './hosted-draft-points';
import { HostedDraftPointView } from './hosted-draft-point-view';
import { HostedPublicationPointVisit } from './hosted-publication-point';
import { HostedPublicationPointView } from './hosted-publication-point-view';
import { admitPublicHostedRelease } from './hosted-release-reader-link-public';

type Props = {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource | null;
  accountId: string | null | undefined;
  csrfToken: string | null;
  locale: Locale;
};
type Mounted = { props: Props; publication: boolean } & (
  | { kind: 'draft'; visit: HostedDraftPointVisit }
  | { kind: 'publication'; visit: HostedPublicationPointVisit }
  | { kind: 'failed' }
);

/** Switching tasks is a departure: reread owner pointers and retire all private selections and effects. */
export function HostedDraftPointEntry(props: Props) {
  const { owner, source, accountId, csrfToken, locale } = props;
  const [publication, setPublication] = useState(false);
  const [retry, setRetry] = useState(0);
  const [mounted, setMounted] = useState<Mounted | null>(null);
  useEffect(() => {
    if (!source || !accountId || !csrfToken || owner.viewer.accountId !== accountId) return;
    const request = new AbortController();
    const origin = source.read();
    let draftVisit: HostedDraftPointVisit | undefined;
    let publicationVisit: HostedPublicationPointVisit | undefined;
    let picker: HostedDraftPicker | undefined;
    void (async () => {
      const fresh = await hostedDraftPointNative.readOwn(
        accountId,
        owner.item.catalogueId,
        request.signal,
        owner.viewer,
      );
      const now = source.read();
      if (request.signal.aborted || now.sourceId !== origin.sourceId || now.generation !== origin.generation) return;
      if (!fresh.ok) {
        setMounted({ props, publication, kind: 'failed' });
        return;
      }
      const documents = createPostDocumentPort({
        projectId: owner.item.catalogueId,
        accountId,
        locale,
        source,
        csrfToken,
        isCurrent: () => draftVisit?.isCurrent() ?? publicationVisit?.isCurrent() ?? !request.signal.aborted,
        admitsPost: (postId) =>
          publicationVisit?.admitsPost(postId) ??
          (picker?.admitsPost(postId) || draftVisit?.admitsPost(postId) || false),
      });
      if (publication) {
        publicationVisit = new HostedPublicationPointVisit({
          owner: fresh.value,
          source,
          locale,
          csrfToken,
          native: hostedPublicationPointNative,
          readVersion: (target, signal) =>
            documents.revision({ projectId: owner.item.catalogueId, document: target }, signal),
          admit: admitPublicHostedRelease,
        });
        setMounted({ props, publication, kind: 'publication', visit: publicationVisit });
        void publicationVisit.refresh();
      } else {
        picker = new HostedDraftPicker({
          viewer: owner.viewer,
          source,
          reader: ownDraftNativeReader,
          locale,
          isCurrent: () => draftVisit?.isCurrent() ?? true,
          readDocument: (postId, signal) => documents.open({ projectId: owner.item.catalogueId, postId }, signal),
        });
        draftVisit = new HostedDraftPointVisit({
          owner: fresh.value,
          source,
          locale,
          csrfToken,
          picker,
          native: hostedDraftPointNative,
          readVersion: (selection, signal) =>
            documents.revision({ projectId: owner.item.catalogueId, document: selection.revision.exact }, signal),
          readTarget: (target, signal) =>
            documents.revision({ projectId: owner.item.catalogueId, document: target }, signal),
        });
        setMounted({ props, publication, kind: 'draft', visit: draftVisit });
        const state = draftVisit.snapshot();
        if (state.kind === 'active') void state.outline.load();
      }
    })();
    return () => {
      request.abort();
      draftVisit?.dispose();
      publicationVisit?.dispose();
    };
  }, [owner, source, accountId, csrfToken, locale, publication, retry]);
  if (
    mounted &&
    mounted.publication === publication &&
    mounted.props.owner === owner &&
    mounted.props.source === source &&
    mounted.props.accountId === accountId &&
    mounted.props.csrfToken === csrfToken &&
    mounted.props.locale === locale
  ) {
    if (mounted.kind === 'publication')
      return <HostedPublicationPointView visit={mounted.visit} locale={locale} onBack={() => setPublication(false)} />;
    if (mounted.kind === 'draft')
      return <HostedDraftPointView visit={mounted.visit} locale={locale} onPublication={() => setPublication(true)} />;
    return (
      <div className="studio-workspace studio-stack" role="alert">
        <p>{m.studio_point_recovery({}, { locale })}</p>
        <div className="studio-action-row">
          <Button type="button" onClick={() => setRetry((value) => value + 1)}>
            {m.studio_point_refresh({}, { locale })}
          </Button>
        </div>
      </div>
    );
  }
  return <p role="status">{m.studio_draft_point_loading({}, { locale })}</p>;
}
