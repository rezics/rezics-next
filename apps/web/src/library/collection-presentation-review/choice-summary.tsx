import { m } from '../../paraglide/messages.js';
import type { TypeChoice, PresentationChoiceState } from './model';

export function choiceStateLabel(state: PresentationChoiceState) {
  return state === 'retained'
    ? m.collection_choice_retained()
    : state === 'automatic'
      ? m.collection_choice_reset_draft()
      : m.collection_choice_replacement();
}

export function typeChoiceLabel(choice: TypeChoice) {
  return choice.availability === 'automatic'
    ? m.library_collection_mixed_label()
    : choice.label || m.collection_choice_type_unavailable();
}

/** These descriptions concern the supplied configuration, not invented Type-specific layouts. */
export function ConfiguredAspect({ choice }: { choice: Pick<TypeChoice, 'presentation'> }) {
  const presentation = choice.presentation;
  if (!presentation)
    return <p className="text-sm text-muted-foreground">{m.collection_choice_configuration_unavailable()}</p>;
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>
        {presentation.imageAspect === 'landscape'
          ? m.collection_choice_landscape()
          : presentation.imageAspect === 'square'
            ? m.collection_choice_square()
            : m.collection_choice_portrait()}
      </p>
      <p>
        {presentation.keyFacts.length
          ? m.collection_choice_configured_facts({ count: presentation.keyFacts.length })
          : m.collection_choice_no_configured_facts()}
      </p>
    </div>
  );
}

export function TypeChoiceMeaning({ choice }: { choice: TypeChoice }) {
  return (
    <div className="space-y-2" data-draft-type-state={choice.state}>
      <p className="font-medium [overflow-wrap:anywhere]">{typeChoiceLabel(choice)}</p>
      <p className="text-sm text-muted-foreground">{choiceStateLabel(choice.state)}</p>
      <p className="text-sm leading-relaxed">
        {choice.availability === 'automatic'
          ? m.collection_choice_automatic_type_help()
          : choice.availability === 'released'
            ? m.collection_choice_explicit_type_help()
            : m.collection_choice_retained_type_help()}
      </p>
      {choice.availability !== 'automatic' ? <ConfiguredAspect choice={choice} /> : null}
      <p className="text-sm text-muted-foreground">{m.collection_choice_member_types_preserved()}</p>
    </div>
  );
}

export function PresentationChangeSummary({
  savedType,
  draftType,
  coverChanged,
  savedCoverLabel,
  draftCoverLabel,
}: {
  savedType: TypeChoice;
  draftType: TypeChoice;
  coverChanged: boolean;
  savedCoverLabel: string;
  draftCoverLabel: string;
}) {
  const typeChanged = draftType.state !== 'retained';
  return (
    <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2" data-presentation-change-summary>
      <div className="min-w-0 space-y-1 rounded-lg border border-border p-3 [overflow-wrap:anywhere]">
        <dt className="font-medium">{m.library_collection_kind()}</dt>
        <dd data-presentation-type-changed={typeChanged}>
          {typeChanged ? m.collection_choice_type_changed() : m.collection_choice_type_unchanged()}
        </dd>
        <dd className="text-muted-foreground">
          {m.collection_choice_saved_value({ value: typeChoiceLabel(savedType) })}
        </dd>
        {typeChanged ? <dd>{m.collection_choice_draft_value({ value: typeChoiceLabel(draftType) })}</dd> : null}
      </div>
      <div className="min-w-0 space-y-1 rounded-lg border border-border p-3 [overflow-wrap:anywhere]">
        <dt className="font-medium">{m.subject_cover()}</dt>
        <dd data-presentation-cover-changed={coverChanged}>
          {coverChanged ? m.collection_choice_cover_changed() : m.collection_choice_cover_unchanged()}
        </dd>
        <dd className="text-muted-foreground">{m.collection_choice_saved_value({ value: savedCoverLabel })}</dd>
        {coverChanged ? <dd>{m.collection_choice_draft_value({ value: draftCoverLabel })}</dd> : null}
      </div>
    </dl>
  );
}
