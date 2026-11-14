import { ImportPageNavigation, useImportPageFocus } from '../personal-list-import/page-navigation';
import { ImportEmpty } from '../personal-list-import/presentation';
import { m } from '../../paraglide/messages.js';
import type { BangumiJourneySnapshot } from './controller';
import type { BangumiImportPort, BangumiLabelPanelState } from './contract';
import { BangumiAction } from './controls';
import { BangumiRowReview, type RowDraft } from './row';
import type { BangumiVisit } from './visit';

export function BangumiReviewPage({
  snap,
  busy,
  navigationLocked = busy,
  port,
  visit,
  labelPanels,
  onLabelPanelChange,
  onSave,
  onChoose,
  onNext,
  onPrevious,
  onFirst,
  onConfirm,
}: {
  snap: BangumiJourneySnapshot;
  busy: boolean;
  navigationLocked?: boolean;
  port: BangumiImportPort;
  visit: BangumiVisit;
  labelPanels: Record<string, BangumiLabelPanelState>;
  onLabelPanelChange: (
    key: string,
    update: (previous: BangumiLabelPanelState | undefined) => BangumiLabelPanelState,
  ) => void;
  onSave: (draft: RowDraft) => void;
  onChoose: (draft: RowDraft) => void;
  onNext: () => void;
  onPrevious: () => void;
  onFirst: () => void;
  onConfirm: () => void;
}) {
  const pageStatus = useImportPageFocus(snap.after);
  const metadata = new Map(snap.meta.map((row) => [row.ordinal, row]));
  const reviewed = snap.meta.filter((row) => row.reviewToken).length;
  return (
    <section className="space-y-6" data-bangumi-stage="review">
      <h2 className="text-xl font-semibold">{m.library_import_review()}</h2>
      <p className="text-sm text-muted-foreground">{m.library_import_review_help()}</p>
      <p ref={pageStatus} role="status" tabIndex={-1} className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
        {snap.count === 0
          ? m.library_import_retained_page({ shown: snap.page.length })
          : m.library_bangumi_page_status({ shown: snap.page.length, total: snap.count, after: snap.after + 1 })}
      </p>
      {snap.cancelled ? <p role="status">{m.library_bangumi_canceled()}</p> : null}
      {snap.page.length === 0 ? <ImportEmpty /> : null}
      <ul className="space-y-6">
        {snap.page.map((row) => {
          const meta = metadata.get(row.ordinal);
          return (
            <li key={row.ordinal}>
              <BangumiRowReview
                row={row}
                {...(meta ? { meta } : {})}
                uploadId={snap.uploadId}
                port={port}
                visit={visit}
                labelPanel={labelPanels[`${snap.uploadId}:${row.ordinal}`]}
                onLabelPanelChange={(update) => onLabelPanelChange(`${snap.uploadId}:${row.ordinal}`, update)}
                busy={busy || snap.cancelled}
                onSave={onSave}
                onChoose={onChoose}
              />
            </li>
          );
        })}
      </ul>
      <ImportPageNavigation
        position={snap.position}
        hasNext={snap.next !== null}
        nextLabel={m.library_bangumi_next_page()}
        busy={navigationLocked || snap.cancelled}
        onFirst={onFirst}
        onPrevious={onPrevious}
        onNext={onNext}
      />
      <div className="flex flex-wrap gap-3">
        <BangumiAction
          type="button"
          disabled={navigationLocked || snap.cancelled || reviewed === 0}
          onClick={onConfirm}
        >
          {m.library_bangumi_continue_confirm()}
        </BangumiAction>
      </div>
    </section>
  );
}
