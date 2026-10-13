import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import { PageHeader } from '../shell/page.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { Region } from '../work-page/region.tsx';
import type { AnimeCollectionView } from './anime-collection-recorded-page.ts';
import { copyOf } from './messages.ts';

function shelfLabel(status: string | null, catalogue: { reading: string; wantToRead: string; read: string }): string | null {
  if (status === 'reading') return catalogue.reading;
  if (status === 'want-to-read') return catalogue.wantToRead;
  if (status === 'read') return catalogue.read;
  return status;
}

/** Resume, shelf status and one unstarted episode, from the reads the tracking controls already make. */
export function AnimeCollectionRecordedPage({ view, locale }: { view: AnimeCollectionView; locale: UiLocale }) {
  const tracking = copyOf(locale);
  const catalogue = materializeData(catalogueMessages[locale], { locale });
  const workPage = materializeData(workMessages[locale], { locale });
  return <div className="grid min-w-0 gap-4">
    <PageHeader title={view.persona} />
    <p className="break-all text-sm text-muted-foreground">{view.actingPerson}</p>
    {view.kind === 'loading' ? <p role="status">{workPage.loadingRegion}</p> : <Region id="anime-collection-episodes" title={tracking.episodes}>
      <dl className="grid min-w-0 gap-4 text-sm">
        <div className="grid gap-1">
          <dt>{tracking.status}</dt>
          <dd>{shelfLabel(view.status, catalogue)}</dd>
          <dd>{view.statusVersion}</dd>
        </div>
        <div className="grid min-w-0 gap-1">
          <dt>{view.resumeLabel ? tracking.lastWatched({ place: view.resumeLabel }) : tracking.unknown}</dt>
          <dd className="break-all">{view.resumeOccurrence}</dd>
          {view.work ? <dd className="break-all">{view.work}</dd> : null}
        </div>
        <div className="grid min-w-0 gap-1">
          <dt>{view.completed ? tracking.watched : tracking.notWatched}</dt>
          <dd className="break-all">{view.progressOccurrence}</dd>
          <dd>{view.progressVersion}</dd>
          <dd>{view.position ?? tracking.notSet}</dd>
        </div>
      </dl>
    </Region>}
  </div>;
}
