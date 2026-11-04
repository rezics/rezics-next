import type { PageContinuation } from '@rezics/composition';
import type { RelationDefinition } from '../../../subject/relations';
import type { Subject } from '../../../subject/types';
import type { Reader } from '../../../subject/reader';
import { defaultReader } from '../../../subject/reader';
import type { PageLink } from '../../pages/shared';
import type { ProfileRelationWindow } from '../../pages/views';
import { mangaReaderAddress } from './navigation';
import { MangaReader } from './view';

export function MangaReaderEntry({
  source,
  subject,
  label,
  locale,
  view,
  context,
  realm,
  continuation,
  viewer,
  definitions,
  windows,
  reader = defaultReader,
  link,
}: {
  source: object;
  subject: Subject;
  label: string;
  locale: string;
  view: string;
  context: string | null;
  realm?: string | undefined;
  continuation?: PageContinuation | undefined;
  viewer: string | null;
  definitions: Record<string, RelationDefinition>;
  windows: readonly ProfileRelationWindow[];
  reader: Reader;
  link?: PageLink;
}) {
  const address = mangaReaderAddress({
    id: subject.id,
    label,
    locale,
    view,
    realm,
    continuation,
  });
  return (
    <MangaReader
      subject={subject}
      locale={locale}
      view={view}
      windows={windows}
      definitions={definitions}
      reader={reader}
      observation={{
        source,
        release: definitions,
        subject: subject.id,
        context,
        locale,
        viewer,
        view,
        window: continuation ? `${continuation.node}\u0000${continuation.cursor}` : null,
      }}
      recoveryHref={address}
      {...(link ? { link } : {})}
    />
  );
}
