import { useQuery } from '@tanstack/react-query';
import type { SelectedContext } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import type { ProfileBound } from '../music-reader';
import type { PageLink } from '../../pages/shared';
import { loadRecordingRelease } from './actions';
import { recordingReaderVisit } from './model';
import { RecordingReader } from './view';

export function RecordingOverview({
  locale,
  public: publicRead,
  bounds,
  context,
  returnTo,
  link,
}: {
  locale: string;
  public: SubjectRead;
  bounds?: readonly ProfileBound[];
  context?: SelectedContext;
  returnTo?: string;
  link?: PageLink;
}) {
  const source = publicRead.subject;
  const query = useQuery({
    queryKey: ['recording-reader', source.id, source.context, source.revision, source.release, locale],
    queryFn: () => loadRecordingRelease({ data: source.release }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const loaded = query.data?.ok ? query.data : undefined;
  const visit = recordingReaderVisit({
    locale,
    public: publicRead,
    ...(loaded ? { release: loaded.release, releaseDigest: loaded.digest } : {}),
    ...(!query.isPending && (!query.data?.ok || query.isError) ? { reason: 'unavailable' as const } : {}),
    ...(bounds ? { bounds } : {}),
    ...(query.isPending ? { loading: true } : {}),
  });
  return (
    <RecordingReader
      visit={visit}
      read={publicRead}
      {...(loaded ? { release: loaded.release } : {})}
      locale={locale}
      {...(context ? { context } : {})}
      {...(returnTo ? { returnTo } : {})}
      {...(link ? { link } : {})}
    />
  );
}
