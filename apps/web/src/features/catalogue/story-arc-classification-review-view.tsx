import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { m } from '../../paraglide/messages.js';
import type { CandidateTransport } from '../../subject/candidate-review';
import { CharacterClassifications } from './character-profile-classification';
import { useCurrentReadingActive } from './editor-lifetime';
import type { EditorRead } from './statement-editor';
import type { FactsCurrent, FactsTransport } from './subject-facts';
import { storyArcClassificationFields, storyArcClassificationTransport } from './story-arc-classification-review';

export function StoryArcClassificationReview({
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
  const o = { locale: locale as never };
  const properties = storyArcClassificationFields(read.release);
  const facts = storyArcClassificationTransport(transport, active, observe);
  return (
    <section className="min-w-0 space-y-4" aria-label={m.story_arc_classification({}, o)}>
      <h2 className="text-xl font-semibold">{m.story_arc_classification({}, o)}</h2>
      <p className="text-sm text-muted-foreground">{m.story_arc_classification_help({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.story_arc_classification_work({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.story_arc_classification_independent({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.story_arc_classification_copy({}, o)}</p>
      <CharacterClassifications
        changedSetReview
        properties={properties}
        read={read}
        locale={locale}
        search={search}
        transport={facts}
        review={review}
      />
    </section>
  );
}
