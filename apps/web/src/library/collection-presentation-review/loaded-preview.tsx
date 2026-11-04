import { MemberListRow } from '@rezics/ui/list-presentation';
import { ReadingDisclosureScope } from '@rezics/ui/cover';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { coverSrc } from '../../media/cover-src';
import { subjectHref } from '../../subject/subject-href';
import { pageText } from '../../features/pages/shared';
import { libraryTitleValue } from '../title';
import { collectionMemberRatio } from '../collection-presentation';
import type { CollectionListPresentations, CollectionTypeOption } from '../collection-presentation';
import type { CollectionComparisonDefinitions } from '../collection-comparison/model';
import { CollectionMemberDetails } from '../collection-member-row';
import type { CollectionMember } from '../reads';
import { ConfiguredAspect } from './choice-summary';
import { loadedTypeContexts } from './model';

/** A local view of supplied public member facts, isolated from reader and preview media reveal state. */
export function LoadedOccurrencePreview({
  members,
  types,
  listPresentations,
  comparisonDefinitions,
  typeRatios,
  scope,
  firstPage,
}: {
  members: readonly CollectionMember[];
  types: readonly CollectionTypeOption[] | null | undefined;
  listPresentations: CollectionListPresentations | undefined;
  comparisonDefinitions: CollectionComparisonDefinitions | undefined;
  typeRatios: Readonly<Record<string, string>> | undefined;
  scope: string;
  firstPage: boolean;
}) {
  const context = loadedTypeContexts(members, types, listPresentations);
  const locale = getLocale();
  return (
    <section className="min-w-0 space-y-4" data-local-occurrence-preview>
      <div className="space-y-2">
        <h4 className="font-semibold">{m.collection_choice_loaded_heading()}</h4>
        <p className="text-sm leading-relaxed text-muted-foreground">{m.collection_choice_loaded_scope()}</p>
        <p className="text-sm text-muted-foreground">
          {firstPage ? m.collection_choice_first_page() : m.collection_choice_later_page()}
        </p>
        <p className="text-sm">{m.collection_choice_loaded_count({ count: members.length })}</p>
      </div>
      {context.types.length ? (
        <details className="min-w-0 rounded-lg border border-border p-3" data-loaded-type-context>
          <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.collection_choice_mixed_context()}</summary>
          <p className="py-2 text-sm text-muted-foreground">{m.collection_choice_mixed_context_help()}</p>
          <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
            {context.types.map((type) => (
              <li key={type.type} className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-3 [overflow-wrap:anywhere]">
                <p className="font-medium">{type.label || m.collection_choice_type_unavailable()}</p>
                <p className="text-sm">{m.collection_choice_type_occurrences({ count: type.occurrences })}</p>
                <ConfiguredAspect choice={type} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {context.unavailable ? (
        <p className="text-sm text-muted-foreground" data-preview-unavailable-members>
          {m.collection_choice_unavailable_count({ count: context.unavailable })}
        </p>
      ) : null}
      {members.length ? (
        <ReadingDisclosureScope value={scope}>
          <ol className="min-w-0 space-y-4" data-preview-occurrences>
            {members.map((member) => {
              const subject = member.subject;
              if (!subject)
                return (
                  <li
                    key={member.id}
                    className="min-w-0 space-y-2 rounded-lg border border-dashed border-border p-4"
                    data-preview-occurrence={member.id}
                    data-preview-availability="unavailable"
                  >
                    <p className="font-medium">{m.library_subject_unavailable()}</p>
                    <p className="text-sm text-muted-foreground">{m.collection_choice_unavailable_member_help()}</p>
                  </li>
                );
              const title = pageText(libraryTitleValue(subject.label), locale);
              const presentation = listPresentations?.[subject.type];
              return (
                <li
                  key={member.id}
                  className="min-w-0"
                  data-preview-occurrence={member.id}
                  data-preview-availability="supplied"
                >
                  <MemberListRow
                    href={subjectHref({ id: subject.id, label: title.text }, locale).href}
                    subject={{ id: subject.id, title: title.text, types: subject.types }}
                    title={title.text}
                    {...(title.lang ? { titleLang: title.lang } : {})}
                    cover={subject.cover}
                    src={coverSrc}
                    ratio={collectionMemberRatio(subject, typeRatios, listPresentations)}
                    {...(presentation ? { listPresentation: presentation } : {})}
                    labels={{
                      withheld: m.thread_cover_withheld(),
                      reveal: m.thread_cover_reveal(),
                      credit: m.thread_cover_credit(),
                      via: m.thread_cover_via(),
                    }}
                  >
                    <CollectionMemberDetails
                      member={member}
                      listPresentations={listPresentations}
                      comparisonDefinitions={comparisonDefinitions}
                    />
                    {!presentation ? (
                      <p className="text-sm text-muted-foreground">
                        {m.collection_choice_member_configuration_missing()}
                      </p>
                    ) : null}
                  </MemberListRow>
                </li>
              );
            })}
          </ol>
        </ReadingDisclosureScope>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {m.collection_choice_no_loaded_members()}
        </p>
      )}
    </section>
  );
}
