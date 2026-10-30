import { useEffect, useState } from 'react';
import { RealmShelf } from '../../../community/space-page';
import { readSpacePage } from '../../../community/space-actions';
import type { SpacePageData } from '../../../community/space';
import { publicationSubjectSearch } from '../../../community/publication-subject-picker';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { PatternStory } from '../../page';

function Shelf({ unavailable, frozen }: { unavailable: boolean; frozen: boolean }) {
  const [page, setPage] = useState<SpacePageData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void readSpacePage({ data: { address: 'atlas-member', credentialMode: 'session' } }).then(
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
  if (failed) return <p role="status">{m.realm_shelf_unavailable()}</p>;
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

/** Recorded native shelf responses; only Search failure is constructed. No permission or success is invented. */
export function RealmPublicationExample({
  unavailable = false,
  frozen = false,
}: {
  unavailable?: boolean;
  frozen?: boolean;
}) {
  return (
    <PatternStory visitor="Signed In" path="/spaces/atlas-member">
      <Shelf unavailable={unavailable} frozen={frozen} />
    </PatternStory>
  );
}
