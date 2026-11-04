import { Cover } from '@rezics/ui/cover';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import type { CollectionListPresentations, CollectionTypeOption } from '../collection-presentation';
import { collectionMemberRatio } from '../collection-presentation';
import type { CollectionMember } from '../reads';
import { ConfiguredAspect } from './choice-summary';
import { loadedTypeContexts, presentationTypeChoice } from './model';

/** Supplied release choices can be corrected in place without changing the preview's occurrence Types. */
export function ReleasedTypeChoices({
  types,
  kind,
  savedKind,
  members,
  listPresentations,
  disabled,
  onChange,
  name,
}: {
  types: readonly CollectionTypeOption[] | null | undefined;
  kind: string | null;
  savedKind: string | null;
  members: readonly CollectionMember[];
  listPresentations: CollectionListPresentations | undefined;
  disabled: boolean;
  onChange: (kind: string | null) => void;
  name: string;
}) {
  const context = loadedTypeContexts(members, types, listPresentations);
  return (
    <fieldset className="min-w-0 space-y-3" disabled={disabled} data-released-type-choices>
      <legend className="font-semibold">{m.collection_choice_released_options()}</legend>
      <p className="text-sm text-muted-foreground">{m.collection_choice_released_options_help()}</p>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
        <input
          type="radio"
          name={name}
          value=""
          checked={kind === null}
          onChange={() => onChange(null)}
          className="mt-1 size-4 shrink-0 accent-primary"
        />
        <span className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
          <span className="block font-medium">{m.library_collection_mixed_label()}</span>
          <span className="block text-sm text-muted-foreground">{m.collection_choice_automatic_type_help()}</span>
        </span>
      </label>
      {kind && !types?.some((type) => type.id === kind) ? (
        <p className="rounded-lg border border-dashed border-border p-3 text-sm" role="status">
          {m.collection_choice_retained_type_help()}
        </p>
      ) : null}
      {types == null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.library_collection_types_unavailable()}
        </p>
      ) : types.length ? (
        <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
          {types.map((type) => {
            const choice = presentationTypeChoice(savedKind, type.id, types, listPresentations);
            const count = context.types.find((loaded) => loaded.type === type.id)?.occurrences ?? 0;
            return (
              <li key={type.id} className="min-w-0 rounded-lg border border-border p-3 has-[:checked]:border-primary">
                <div className="flex min-w-0 items-start gap-3">
                  {choice.presentation ? (
                    <div className="w-16 shrink-0" aria-hidden="true" data-type-frame-example>
                      <Cover
                        subject={{ id: `type-frame:${type.id}`, title: type.label, types: [type.id] }}
                        cover={null}
                        size="fill"
                        src={coverSrc}
                        ratio={collectionMemberRatio({ type: type.id }, undefined, listPresentations)}
                        listPresentation={choice.presentation}
                        decorative
                      />
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1 space-y-2 [overflow-wrap:anywhere]">
                    <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-sm py-1 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                      <input
                        type="radio"
                        name={name}
                        value={type.id}
                        checked={kind === type.id}
                        onChange={() => onChange(type.id)}
                        className="mt-1 size-4 shrink-0 accent-primary"
                      />
                      <span className="font-medium">{type.label || m.collection_choice_type_unavailable()}</span>
                    </label>
                    <ConfiguredAspect choice={choice} />
                    <p className="text-sm text-muted-foreground">
                      {count ? m.collection_choice_type_occurrences({ count }) : m.collection_choice_type_not_loaded()}
                    </p>
                    {kind === type.id ? <p className="text-sm">{m.collection_choice_selected_type()}</p> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{m.collection_choice_no_released_types()}</p>
      )}
      <p className="text-sm text-muted-foreground">{m.collection_choice_type_frame_help()}</p>
    </fieldset>
  );
}
