import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import {
  knowledgeTemplateKinds,
  type KnowledgeAuthoringDestination,
  type KnowledgePlacementChoice,
  type KnowledgeTemplateKind,
} from './authoring.ts';

const controlClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function localeOptions(locale: string) {
  return { locale: locale as never };
}

export function knowledgeTemplateCopy(kind: KnowledgeTemplateKind, locale: string) {
  const options = localeOptions(locale);
  switch (kind) {
    case 'inspiration':
      return {
        kind,
        title: m.knowledge_private_template_inspiration_title({}, options),
        body: m.knowledge_private_template_inspiration_body({}, options),
      };
    case 'arc':
      return {
        kind,
        title: m.knowledge_private_template_arc_title({}, options),
        body: m.knowledge_private_template_arc_body({}, options),
      };
    case 'scene':
      return {
        kind,
        title: m.knowledge_private_template_scene_title({}, options),
        body: m.knowledge_private_template_scene_body({}, options),
      };
  }
}

export function KnowledgePlacementChoiceBar({
  locale,
  choice,
  disabled,
  onChange,
}: {
  locale: string;
  choice: KnowledgePlacementChoice;
  disabled: boolean;
  onChange: (choice: KnowledgePlacementChoice) => void;
}) {
  const options = localeOptions(locale);
  return (
    <div
      role="group"
      aria-label={m.knowledge_private_choose_notebook({}, options)}
      className="flex min-w-0 flex-wrap gap-3"
    >
      <Button
        type="button"
        variant={choice === 'new-notebook' ? 'default' : 'outline'}
        className={controlClass}
        aria-pressed={choice === 'new-notebook'}
        disabled={disabled}
        onClick={() => onChange('new-notebook')}
      >
        {m.knowledge_private_new_notebook({}, options)}
      </Button>
      <Button
        type="button"
        variant={choice === 'existing-notebook' ? 'default' : 'outline'}
        className={controlClass}
        aria-pressed={choice === 'existing-notebook'}
        disabled={disabled}
        onClick={() => onChange('existing-notebook')}
      >
        {m.knowledge_private_existing_notebook({}, options)}
      </Button>
    </div>
  );
}

export function KnowledgeTemplatePicker({
  locale,
  selected,
  disabled,
  onSelect,
}: {
  locale: string;
  selected: KnowledgeTemplateKind | null;
  disabled: boolean;
  onSelect: (kind: KnowledgeTemplateKind) => void;
}) {
  const options = localeOptions(locale);
  const label = (kind: KnowledgeTemplateKind) =>
    kind === 'inspiration'
      ? m.knowledge_private_template_inspiration({}, options)
      : kind === 'arc'
        ? m.knowledge_private_template_arc({}, options)
        : m.knowledge_private_template_scene({}, options);
  return (
    <section className="min-w-0 space-y-3" aria-labelledby="knowledge-private-template">
      <h2 id="knowledge-private-template" className="text-lg font-semibold">
        {m.knowledge_private_template({}, options)}
      </h2>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.knowledge_private_template_intro({}, options)}
      </p>
      <div role="group" aria-label={m.knowledge_private_template({}, options)} className="flex min-w-0 flex-wrap gap-3">
        {knowledgeTemplateKinds.map((kind) => (
          <Button
            key={kind}
            type="button"
            variant={selected === kind ? 'default' : 'outline'}
            className={controlClass}
            aria-pressed={selected === kind}
            disabled={disabled}
            onClick={() => onSelect(kind)}
          >
            {label(kind)}
          </Button>
        ))}
      </div>
    </section>
  );
}

export function KnowledgeDestinationReview({
  locale,
  destination,
  subjectIds,
}: {
  locale: string;
  destination: KnowledgeAuthoringDestination;
  subjectIds: readonly string[];
}) {
  const options = localeOptions(locale);
  const parent =
    destination.parentPlacementId === null
      ? m.knowledge_private_destination_root({}, options)
      : (destination.parentTitle ?? destination.parentPlacementId);
  return (
    <section
      className="min-w-0 space-y-3 border-t border-border pt-5"
      aria-labelledby="knowledge-private-destination-review"
    >
      <h3 id="knowledge-private-destination-review" className="font-medium">
        {m.knowledge_private_review_destination({}, options)}
      </h3>
      <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <dt className="text-sm font-medium text-foreground">{m.knowledge_private_notebook_title({}, options)}</dt>
          <dd className="min-w-0 break-words">{destination.notebookTitle}</dd>
        </div>
        <div className="min-w-0 space-y-1">
          <dt className="text-sm font-medium text-foreground">{m.knowledge_private_notebook_id({}, options)}</dt>
          <dd className="min-w-0 break-all font-mono text-sm text-muted-foreground">{destination.notebookId}</dd>
        </div>
        <div className="min-w-0 space-y-1">
          <dt className="text-sm font-medium text-foreground">{m.knowledge_private_destination_parent({}, options)}</dt>
          <dd className="min-w-0 break-words">{parent}</dd>
        </div>
        <div className="min-w-0 space-y-1">
          <dt className="text-sm font-medium text-foreground">{m.knowledge_private_structure_revision({}, options)}</dt>
          <dd className="min-w-0 break-all font-mono text-sm text-muted-foreground">
            {destination.structureRevisionId}
          </dd>
        </div>
        <div className="min-w-0 space-y-1 sm:col-span-2">
          <dt className="text-sm font-medium text-foreground">{m.knowledge_private_subject_ids({}, options)}</dt>
          <dd className="min-w-0 break-all font-mono text-sm text-muted-foreground">{subjectIds.join(', ')}</dd>
        </div>
      </dl>
    </section>
  );
}
