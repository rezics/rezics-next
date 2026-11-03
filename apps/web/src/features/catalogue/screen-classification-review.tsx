import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import type { CandidateTransport } from '../../subject/candidate-review';
import { CharacterClassifications, classificationFields } from './character-profile-classification';
import { useCurrentReadingActive } from './editor-lifetime';
import { screenGroups } from './screen-profile';
import type { FactsCurrent, FactsTransport } from './subject-facts';
import type { EditorRead } from './statement-editor';

export function screenClassificationTransport(
  transport: FactsTransport,
  active: () => boolean,
  observe: (next: EditorRead) => void,
): FactsTransport {
  return {
    ...transport,
    read: async () => {
      if (!active()) throw new Error('Retired catalogue editor');
      let next: EditorRead;
      try {
        next = await transport.read();
      } catch {
        next = { ok: false, reason: 'unavailable' };
      }
      if (!active()) throw new Error('Retired catalogue editor');
      observe(next);
      return next;
    },
  };
}

export function ScreenClassificationReview({
  read,
  locale,
  search,
  transport,
  review,
  observe,
}: {
  read: FactsCurrent;
  locale: string;
  search: EntityPickerSearch;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  observe: (next: EditorRead) => void;
}) {
  const active = useCurrentReadingActive();
  const groups = screenGroups(read.release, read.public.subject.type);
  const properties = classificationFields(read.release, read.public.subject.type, groups.classification);
  const facts = screenClassificationTransport(transport, active, observe);
  return (
    <CharacterClassifications
      changedSetReview
      properties={properties}
      read={read}
      locale={locale}
      search={search}
      transport={facts}
      review={review}
    />
  );
}
