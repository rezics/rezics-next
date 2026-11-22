import { useEffect, useState } from 'react';
import { RealmShelf } from '../../../session/community-application';
import { readSpacePage } from '../../../community/space-actions';
import type { SpacePageData } from '../../../community/space';
import { publicationSubjectSearch } from '../../../community/publication-subject-picker';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { PatternStory } from '../../page';

export const publicationSpaceAddress = 'readers-realm';

function Shelf({ unavailable, frozen }: { unavailable: boolean; frozen: boolean }) {
  const [page, setPage] = useState<SpacePageData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void readSpacePage({ data: { address: publicationSpaceAddress, credentialMode: 'session' } }).then(
      (value) => {
        if (active) setPage(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (failed || (page && !page.realm)) return <p role="status">{m.realm_shelf_unavailable()}</p>;
  if (!page?.realm) return null;
  return (
    <div className="space-y-10">
      <RealmShelf
        realm={page.realm}
        frozen={frozen}
        search={
          unavailable
            ? publicationSubjectSearch(getLocale(), async () => {
                throw new Error('Constructed Search dependency failure');
              })
            : undefined
        }
      />
    </div>
  );
}

/** Mount the same illustrative Realm home and shelf reads as the routed community preview. */
export function RealmPublicationExample({
  unavailable = false,
  frozen = false,
}: {
  unavailable?: boolean;
  frozen?: boolean;
}) {
  return (
    <PatternStory visitor="Signed In" path={`/spaces/${publicationSpaceAddress}`}>
      <Shelf unavailable={unavailable} frozen={frozen} />
    </PatternStory>
  );
}
