import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowLink } from '@rezics/ui/list-row';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import type { MouseEvent, ReactNode, Ref } from 'react';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { CandidateValue } from './data';
import { spoilerLevel } from './shared';
import { SpoilerGate } from './values';
import {
  admittedQualifiers,
  appearanceRoleProperty,
  spoilerProperty,
  streamKindGroup,
  type CharacterAssociationRow,
  type CharacterAssociationStream,
  type CharacterRelationshipsRead,
  type UnavailableConfiguration,
} from '../catalogue/character-relationships/reading';

export const characterRelationshipsActionClass =
  'h-auto min-h-8 max-w-full whitespace-normal [overflow-wrap:anywhere] py-1.5 max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
export const characterRelationshipsSummaryClass =
  'cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:py-2';
export const characterRelationshipsLinkClass =
  'block w-fit max-w-full font-sans font-semibold underline max-md:min-h-11 max-md:min-w-11 max-md:py-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:py-2';

const kindMessage = (kind: CharacterAssociationStream['kind'], locale: string) => {
  const o = { locale: locale as never };
  if (kind === 'appearance') return m.character_relationships_kind_appearance({}, o);
  if (kind === 'voice') return m.character_relationships_kind_voice({}, o);
  return m.character_relationships_kind_relationship({}, o);
};

const unavailableMessage = (id: UnavailableConfiguration['id'], locale: string) => {
  const o = { locale: locale as never };
  if (id === 'age-at-appearance') return m.character_relationships_age_unreleased({}, o);
  if (id === 'main-character-linkage') return m.character_relationships_main_unreleased({}, o);
  return m.character_relationships_relation_unreleased({}, o);
};

export function CharacterRelationshipsUnavailable({
  items,
  locale,
}: {
  items: readonly UnavailableConfiguration[];
  locale: string;
}) {
  if (!items.length) return null;
  return (
    <ul data-slot="character-relationships-unreleased" className="space-y-2 text-sm text-muted-foreground">
      {items.map((item) => (
        <li key={item.id}>{unavailableMessage(item.id, locale)}</li>
      ))}
    </ul>
  );
}

function AssociationStatement({
  row,
  stream,
  read,
  locale,
  onCorrect,
}: {
  row: CharacterAssociationRow;
  stream: CharacterAssociationStream;
  read: Extract<CharacterRelationshipsRead, { ok: true }>;
  locale: string;
  onCorrect?: (
    row: CharacterAssociationRow,
    stream: CharacterAssociationStream,
    opener: HTMLButtonElement,
    keyboard: boolean,
  ) => void;
}) {
  const o = { locale: locale as never };
  const descriptor = row.holderType ? read.descriptors[row.holderType] : undefined;
  const admitted = descriptor?.ok ? admittedQualifiers(descriptor.descriptor, stream.property) : undefined;
  const descriptorFailed = row.holderType && descriptor && !descriptor.ok;
  if (!row.statement) return <p>{m.character_relationships_assertion_unavailable({}, o)}</p>;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">{kindMessage(stream.kind, locale)}</p>
      <p className="text-muted-foreground">
        {stream.direction === 'forward'
          ? m.character_relationships_direction_forward({}, o)
          : m.character_relationships_direction_inverse({}, o)}
      </p>
      <div>
        <p lang={read.labels[row.statement.property.id]?.lang ?? undefined} className="text-muted-foreground">
          {read.labels[row.statement.property.id]?.text || m.subject_value_unlabelled({}, o)}
        </p>
        <CandidateValue snak={row.statement} related={row.related} locale={locale} />
      </div>
      {row.statement.qualifiers.map((snak, index) => {
        const unadmitted = admitted && !admitted.includes(snak.property.id);
        const age = snak.property.data_type === 'quantity' && snak.property.id !== spoilerProperty;
        const role = snak.property.id === appearanceRoleProperty;
        return (
          <div
            key={index}
            data-qualifier={snak.property.id}
            data-appearance-age={age ? 'true' : undefined}
            data-appearance-role={role ? 'true' : undefined}
            data-unadmitted={unadmitted ? 'true' : undefined}
          >
            <p lang={read.labels[snak.property.id]?.lang ?? undefined} className="text-muted-foreground">
              {read.labels[snak.property.id]?.text || m.subject_value_unlabelled({}, o)}
            </p>
            <CandidateValue snak={snak} related={row.related} locale={locale} />
            {unadmitted && <p className="text-muted-foreground">{m.character_relationships_field_unreleased({}, o)}</p>}
          </div>
        );
      })}
      {descriptorFailed && <p role="status">{m.character_relationships_descriptor_unavailable({}, o)}</p>}
      <section className="space-y-2" aria-label={m.sources_citations({}, o)}>
        <h3 className="font-medium">{m.sources_citations({}, o)}</h3>
        {row.statement.references.length ? (
          row.statement.references.map((reference, index) => (
            <div key={index} className="space-y-2 border-s-2 border-border ps-3">
              {reference.parts.length ? (
                reference.parts.map((snak, at) => (
                  <div key={at}>
                    <p lang={read.labels[snak.property.id]?.lang ?? undefined} className="text-muted-foreground">
                      {read.labels[snak.property.id]?.text || m.subject_value_unlabelled({}, o)}
                    </p>
                    <CandidateValue snak={snak} related={row.related} locale={locale} />
                  </div>
                ))
              ) : (
                <p>{m.value_reference_unavailable({}, o)}</p>
              )}
            </div>
          ))
        ) : (
          <p>{m.sources_no_citations({}, o)}</p>
        )}
      </section>
      {onCorrect && (
        <Button
          className={characterRelationshipsActionClass}
          variant="outline"
          onClick={(event) => onCorrect(row, stream, event.currentTarget, event.detail === 0)}
        >
          {m.character_relationships_correct({}, o)}
        </Button>
      )}
    </div>
  );
}

export function CharacterRelationshipsGroups({
  id,
  locale,
  read,
  streamId,
  selectedWork,
  busy,
  sliceStatus,
  onSelectStream,
  onSelectWork,
  onCorrect,
  onMore,
  onRestart,
}: {
  id: string;
  locale: string;
  read: Extract<CharacterRelationshipsRead, { ok: true }>;
  streamId: string;
  selectedWork?: string | undefined;
  busy?: boolean;
  sliceStatus?: Ref<HTMLParagraphElement>;
  onSelectStream?: (key: string) => void;
  onSelectWork?: (work: string | undefined) => void;
  onCorrect?: (
    row: CharacterAssociationRow,
    stream: CharacterAssociationStream,
    opener: HTMLButtonElement,
    keyboard: boolean,
  ) => void;
  onMore?: (event: MouseEvent<HTMLButtonElement>) => void;
  onRestart?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const o = { locale: locale as never };
  const title = pickText(read.public.subject.labels, locale);
  const stream = read.stream;
  const groups = (['appearances', 'relationships', 'voice'] as const).map((group) => ({
    group,
    streams: read.streams.filter((item) => streamKindGroup(item.kind) === group),
  }));
  return (
    <div data-slot="character-relationships" className="space-y-6">
      <a
        className={`${characterRelationshipsLinkClass} text-xl`}
        lang={title.lang ?? undefined}
        href={subjectHref({ id, label: title.text }, locale).href}
      >
        {title.text || m.subject_value_unlabelled({}, o)}
      </a>
      <CharacterRelationshipsUnavailable items={read.unavailable} locale={locale} />
      <ul className="flex flex-wrap gap-2 text-sm">
        {groups.map(({ group, streams }) =>
          streams.length ? (
            <li key={group} data-slot={`character-relationships-${group}`}>
              {group === 'appearances'
                ? m.character_relationships_appearances({}, o)
                : group === 'voice'
                  ? m.character_relationships_voice({}, o)
                  : m.character_relationships_relations({}, o)}
              {` (${streams.length})`}
            </li>
          ) : null,
        )}
      </ul>
      {read.independentlyUnreadable && (
        <p role="status">
          {m.character_relationships_endpoint_unreadable({ stream: read.independentlyUnreadable.key }, o)}
        </p>
      )}
      {!read.streams.length && (
        <p ref={sliceStatus} role="status" tabIndex={-1}>
          {m.character_relationships_no_stream({}, o)}
        </p>
      )}
      {stream && (
        <>
          <Field>
            <FieldLabel htmlFor={streamId}>{m.character_relationships_stream({}, o)}</FieldLabel>
            <NativeSelect
              id={streamId}
              className="min-w-0 max-w-full max-md:[&_select]:min-h-11 max-md:[&_select]:min-w-11 pointer-coarse:[&_select]:min-h-11 pointer-coarse:[&_select]:min-w-11"
              value={stream.key}
              disabled={busy}
              onChange={(event) => onSelectStream?.(event.target.value)}
            >
              {read.streams.map((item) => (
                <NativeSelectOption key={item.key} value={item.key} lang={item.label.lang ?? undefined}>
                  {`${kindMessage(item.kind, locale)} · ${item.label.text || m.subject_value_unlabelled({}, o)}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <p ref={sliceStatus} role="status" tabIndex={-1}>
            {m.character_relationships_slice({}, o)}{' '}
            {read.count &&
              m.character_relationships_count(
                {
                  count: read.count.value,
                  accuracy: read.count.exact
                    ? m.character_relationships_exact({}, o)
                    : m.character_relationships_at_least({}, o),
                },
                o,
              )}
          </p>
          {!read.caughtUp && <p role="status">{m.character_relationships_pending({}, o)}</p>}
          {!read.rows.length && !read.independentlyUnreadable && <p>{m.character_relationships_empty({}, o)}</p>}
          <ul>
            {read.rows.map((row, index) => {
              const vanished = !row.summary;
              const selected = selectedWork === row.holder;
              const level = row.statement ? spoilerLevel(row.statement) : 0;
              const item = (
                <>
                  {row.summary ? (
                    <ListRowLink
                      href={subjectHref({ id: row.summary.id, label: row.summary.label?.value ?? '' }, locale).href}
                      lang={row.summary.label?.language}
                      aria-labelledby={`${streamId}-row-${index}`}
                    >
                      {row.summary.label?.value || m.subject_value_unlabelled({}, o)}
                    </ListRowLink>
                  ) : (
                    <p>{m.character_relationships_vanished({}, o)}</p>
                  )}
                  <ContentItemHeading
                    id={`${streamId}-row-${index}`}
                    lang={row.summary?.label?.language}
                    className="font-sans text-[17px] leading-snug font-semibold whitespace-normal [overflow-wrap:anywhere] sm:text-lg md:text-xl"
                  >
                    {row.summary
                      ? row.summary.label?.value || m.subject_value_unlabelled({}, o)
                      : m.character_relationships_unresolved({}, o)}
                  </ContentItemHeading>
                  {stream.kind === 'appearance' && onSelectWork && (
                    <Button
                      className={characterRelationshipsActionClass}
                      variant={selected ? 'default' : 'outline'}
                      aria-pressed={selected}
                      onClick={() => onSelectWork(selected ? undefined : row.holder)}
                    >
                      {selected
                        ? m.character_relationships_selected_work({}, o)
                        : m.character_relationships_switch({}, o)}
                    </Button>
                  )}
                  <div
                    data-content-item-slot="preview"
                    hidden={stream.kind === 'appearance' && !!selectedWork && !selected}
                    className="min-w-0 space-y-3 text-sm leading-relaxed [&_a]:relative [&_a]:z-10 [&_a]:whitespace-normal [&_a]:[overflow-wrap:anywhere] [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring [&_button]:relative [&_button]:z-10 [&_summary]:relative [&_summary]:z-10"
                  >
                    {vanished ? (
                      onCorrect &&
                      row.statement && (
                        <Button
                          className={characterRelationshipsActionClass}
                          variant="outline"
                          onClick={(event) => onCorrect(row, stream, event.currentTarget, event.detail === 0)}
                        >
                          {m.character_relationships_correct({}, o)}
                        </Button>
                      )
                    ) : (
                      <AssociationStatement
                        row={row}
                        stream={stream}
                        read={read}
                        locale={locale}
                        {...(onCorrect ? { onCorrect } : {})}
                      />
                    )}
                    <details className="rounded-lg border border-border p-3 text-sm">
                      <summary className={characterRelationshipsSummaryClass}>
                        {m.catalogue_technical_details({}, o)}
                      </summary>
                      <dl className="mt-3 space-y-2 [&_dd]:break-all [&_dd]:font-mono [&_dd]:text-xs">
                        <div>
                          <dt>{m.character_relationships_holder({}, o)}</dt>
                          <dd>{row.holder}</dd>
                        </div>
                        <div>
                          <dt>{m.character_relationships_stream({}, o)}</dt>
                          <dd>{stream.property}</dd>
                        </div>
                        <div>
                          <dt>{m.catalogue_statement_id({}, o)}</dt>
                          <dd>{row.statementId}</dd>
                        </div>
                      </dl>
                    </details>
                  </div>
                </>
              );
              return (
                <li
                  key={`${row.holder}:${row.statementId}`}
                  data-slot="list-row"
                  data-selected={selected ? 'true' : undefined}
                  data-vanished={vanished ? 'true' : undefined}
                  aria-labelledby={`${streamId}-row-${index}`}
                >
                  <ContentItemFrame as="div" className="min-w-0 space-y-3 py-3 sm:py-4">
                    {level > 0 ? (
                      <SpoilerGate
                        label={m.character_relationships_spoiler_show({}, o)}
                        hideLabel={m.character_relationships_spoiler_hide({}, o)}
                      >
                        {item}
                      </SpoilerGate>
                    ) : (
                      item
                    )}
                  </ContentItemFrame>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            {read.next && onMore && (
              <Button className={characterRelationshipsActionClass} variant="outline" disabled={busy} onClick={onMore}>
                {m.character_relationships_more({}, o)}
              </Button>
            )}
            {onRestart && (
              <Button
                className={characterRelationshipsActionClass}
                variant="outline"
                disabled={busy}
                onClick={onRestart}
              >
                {m.character_relationships_restart({}, o)}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function CharacterRelationshipsHeading({ locale, actions }: { locale: string; actions?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-2">
        <h1 className="font-sans text-3xl font-semibold tracking-tight">
          {m.character_relationships_title({}, { locale: locale as never })}
        </h1>
        <p className="max-w-prose text-muted-foreground">
          {m.character_relationships_intro({}, { locale: locale as never })}
        </p>
      </div>
      {actions}
    </div>
  );
}
