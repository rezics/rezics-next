import type { SelectedContext } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { loadRecordingRelease } from './actions';
import type { ProfileBound } from '../music-reader';
import type { PageLink } from '../../pages/shared';
import { RecordingReader } from './view';
import { useRecordingRelease, type RecordingReleaseLoader } from './review/release';

const readRelease: RecordingReleaseLoader = (digest) => loadRecordingRelease({ data: digest });

export function RecordingOverview({
  locale,
  public: publicRead,
  bounds,
  context,
  returnTo,
  currentHref,
  link,
  loadRelease = readRelease,
}: {
  locale: string;
  public: SubjectRead;
  bounds?: readonly ProfileBound[];
  context?: SelectedContext;
  returnTo?: string;
  currentHref?: string;
  link?: PageLink;
  /** Injectable only for mounted examples; production uses the authenticated server function above. */
  loadRelease?: RecordingReleaseLoader;
}) {
  const episode = useRecordingRelease({
    locale,
    public: publicRead,
    ...(bounds ? { bounds } : {}),
    ...(context ? { context } : {}),
    loadRelease,
  });
  const release: Release | undefined = episode.release;

  return (
    <RecordingReader
      visit={episode.visit}
      read={publicRead}
      {...(release ? { release } : {})}
      locale={locale}
      {...(context ? { context } : {})}
      {...(returnTo ? { returnTo } : {})}
      {...(currentHref ? { currentHref } : {})}
      retryAvailable={episode.retryAvailable}
      retrying={episode.retrying}
      onRetry={episode.retry}
      scope={episode.generation}
      active={episode.active}
      {...(link ? { link } : {})}
    />
  );
}
