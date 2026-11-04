import type { ComponentProps, MouseEvent } from 'react';
import { m } from '../../../paraglide/messages.js';
import { CandidateValue } from '../../pages/data';
import { subjectHref } from '../../../subject/subject-href';
import { contextHref } from '../../pages/context-navigation';
import { ValueExplanationEntry } from '../value-explanation-entry';
import { historicalStatement } from '../release-fidelity/model';
import { profileSourceRecords } from '../music-reader';
import type { NativeOperationAvailability } from '../../../subject/candidates';
import { musicReleaseDate, type MusicReleaseRead } from './model';
import { musicReleaseLinkHref, musicReleaseReturnHref, type MusicReleaseReturn } from './navigation';

type Ready = Extract<MusicReleaseRead, { ok: true }>;
type Statement = Ready['public']['subject']['statements'][string][number];
const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center break-words underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
export function MusicReleaseFacts({
  page,
  locale,
  current,
  correction,
  onNavigate,
}: {
  page: Ready;
  locale: string;
  realm?: string | undefined;
  current: MusicReleaseReturn;
  correction: NativeOperationAvailability;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const o = { locale: locale as never };
  const base = subjectHref({ id: page.identity.id, label: page.identity.label.text }, locale).href;
  const returnTo = musicReleaseReturnHref(current);
  const sources = profileSourceRecords(page.public.subject);
  const Link = (props: ComponentProps<'a'>) => (
    <a
      {...props}
      className={action}
      href={musicReleaseLinkHref(props.href ?? '', current)}
      target="_blank"
      rel="noopener"
      onClick={onNavigate}
    />
  );
  const evidenceValue = (snak: Statement['qualifiers'][number]) => {
    if (snak.property.data_type === 'wikibase-item' && snak.value.type === 'value') {
      const target = typeof snak.value.content === 'string' ? snak.value.content : '';
      const labels = page.public.related[target]?.labels ?? {};
      if (!Object.values(labels).some(Boolean)) return <span>{m.work_parts_unresolved({}, o)}</span>;
    }
    return <CandidateValue snak={snak} related={page.public.related} locale={locale} link={Link} />;
  };
  return (
    <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]" data-slot="music-release-facts">
      {!page.admitted ? (
        <p role="status">{m.music_release_unsupported({}, o)}</p>
      ) : (
        <>
          <p>
            {m.music_release_edition({}, o)}:{' '}
            <span lang={page.identity.label.lang ?? undefined}>{page.identity.label.text}</span>
          </p>
          {page.unsupported.map((property) => (
            <p key={property} role="status">
              {m.music_release_field_unavailable({ property }, o)}
            </p>
          ))}
          {page.unreleasedGrains.length ? <p role="status">{m.music_release_unconfigured({}, o)}</p> : null}
          {!page.facts.some((fact) => fact.kind === 'album') ? <p>{m.music_release_album_unavailable({}, o)}</p> : null}
          <dl className="space-y-4">
            {page.facts.map((fact) => (
              <div key={fact.property}>
                <dt className="font-semibold" lang={fact.label.lang ?? undefined}>
                  {fact.kind === 'album' ? `${m.music_release_album({}, o)} · ` : ''}
                  {fact.label.text || m.work_parts_unresolved({}, o)}
                </dt>
                <dd className="space-y-3">
                  {!fact.statements.length ? (
                    <p>
                      {fact.kind === 'date' ? m.release_fidelity_date_absent({}, o) : m.music_release_absent({}, o)}
                    </p>
                  ) : null}
                  {fact.statements.map((statement) => {
                    const date = fact.kind === 'date' ? musicReleaseDate(statement, page.digest, locale) : undefined;
                    return (
                      <details key={statement.id} className="rounded-lg border border-border p-3">
                        <summary className={`${action} cursor-pointer`}>{m.music_release_inspect_statement({}, o)}</summary>
                        <div className="space-y-2 pt-3">
                        {date ? (
                          <p data-date-kind={date.kind}>
                            {date.kind === 'tba'
                              ? m.release_fidelity_date_tba({}, o)
                              : date.kind === 'none'
                                ? m.release_fidelity_date_none({}, o)
                                : date.kind === 'unknown'
                                  ? m.subject_value_unknown({}, o)
                                  : date.text}
                          </p>
                        ) : statement.property.data_type === 'wikibase-item' &&
                          statement.value.type === 'value' &&
                          typeof statement.value.content === 'string' &&
                          !Object.values(page.public.related[statement.value.content]?.labels ?? {}).some(Boolean) ? (
                          <p>{m.work_parts_unresolved({}, o)}</p>
                        ) : (
                          <CandidateValue snak={statement} related={page.public.related} locale={locale} link={Link} />
                        )}
                        {historicalStatement(statement, page.digest) ? (
                          <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
                        ) : null}
                        <details className="rounded-lg border border-border p-3">
                          <summary className={`${action} cursor-pointer`}>{m.sources_citations({}, o)}</summary>
                          {[statement.qualifiers, ...statement.references.map((reference) => reference.parts)].map(
                            (parts, group) => (
                              <dl key={group} className="my-3 space-y-2">
                                {parts.map((snak, index) => (
                                  <div key={index}>
                                    <dt lang={page.labels[snak.property.id]?.lang ?? undefined}>
                                      {page.labels[snak.property.id]?.text || m.work_parts_unresolved({}, o)}
                                    </dt>
                                    <dd>{evidenceValue(snak)}</dd>
                                  </div>
                                ))}
                              </dl>
                            ),
                          )}
                          <p className="text-sm">
                            {statement.id} · {statement.rank} · {statement.rezics.release}
                          </p>
                          <ValueExplanationEntry
                            id={page.identity.id}
                            title={page.identity.label.text}
                            statement={statement.id}
                            property={statement.property.id}
                            context={current.address.context}
                            locale={locale}
                            returnTo={returnTo}
                          />
                        </details>
                        </div>
                      </details>
                    );
                  })}
                </dd>
              </div>
            ))}
          </dl>
          <section className="space-y-2">
            <h3 className="font-semibold">{m.music_reader_source_evidence({}, o)}</h3>
            <p>{m.music_reader_source_editorial({}, o)}</p>
            {!sources.length ? (
              <p>{m.music_reader_source_unavailable({}, o)}</p>
            ) : (
              <ul>
                {sources.map((source, index) => (
                  <li key={index} className="space-y-1">
                    {/https?:\/\//.test(source.url) && /^https?:/.test(source.url) ? (
                      <Link href={source.url}>{source.name}</Link>
                    ) : (
                      <span>{source.name}</span>
                    )}
                    {source.attribution ? <p>{source.attribution}</p> : null}
                    {source.licence ? (
                      <p>
                        {source.licence.url && /^https?:\/\//.test(source.licence.url) ? (
                          <Link href={source.licence.url}>{source.licence.id}</Link>
                        ) : (
                          source.licence.id
                        )}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <Link href={`${base}/details`}>{m.music_release_generic({}, o)}</Link>
      {correction === 'allowed' ? (
        <Link href={`${base}/edit`}>{m.music_release_correct({}, o)}</Link>
      ) : (
        <p role="status">
          {correction === 'denied' ? m.correction_denied({}, o) : m.correction_actions_unavailable({}, o)}
        </p>
      )}
    </div>
  );
}

/** Listing labels describe an occurrence; they never become an invented medium or target identity. */
export function MusicReleaseSlot({ row, page, locale }: { row: Ready['rows'][number]; page: Ready; locale: string }) {
  const o = { locale: locale as never };
  const slotKey = page.stream?.slotKey;
  const slots =
    row.statement?.qualifiers.filter(
      (snak) => snak.property.id === slotKey || snak.property.id === 'schema:position',
    ) ?? [];
  if (!slots.length) return null;
  return (
    <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-sm [overflow-wrap:anywhere]">
      {slots.map((snak, index) => (
        <div key={index}>
          <dt className="text-muted-foreground" lang={page.labels[snak.property.id]?.lang ?? undefined}>
            {page.labels[snak.property.id]?.text || m.music_release_slot({}, o)}
          </dt>
          <dd>
            <CandidateValue snak={snak} related={row.related} locale={locale} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Inspect one holder/assertion pair from the accepted window, without reading the target. */
export function MusicReleaseOccurrenceFacts({
  row,
  page,
  locale,
  realm,
  current,
  correction,
  onNavigate,
}: {
  row: Ready['rows'][number];
  page: Ready;
  locale: string;
  realm?: string | undefined;
  current: MusicReleaseReturn;
  correction: NativeOperationAvailability;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const o = { locale: locale as never };
  const stream = page.stream;
  if (!stream) return null;
  const summary = row.summary;
  const type = summary ? page.types[summary.type] : undefined;
  const statement = row.statement;
  const assertionRelated =
    stream.direction === 'inverse'
      ? { [page.identity.id]: { type: page.public.subject.type, labels: page.public.subject.labels } }
      : summary
        ? {
            [summary.id]: {
              type: summary.type,
              labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
            },
          }
        : {};
  const targetHref = summary
    ? contextHref(subjectHref({ id: summary.id, label: summary.label?.value ?? '' }, locale).href, realm)
    : undefined;
  // The inverse stream holder is the supplied source, never the edition or another row's recording.
  const holderHref = contextHref(
    subjectHref(
      {
        id: row.holder,
        label: row.holder === page.identity.id ? page.identity.label.text : (summary?.label?.value ?? ''),
      },
      locale,
    ).href,
    realm,
  );
  const correctionHref = contextHref(`${holderHref.split('?')[0]}/relation-edit`, realm);
  const Link = (props: ComponentProps<'a'>) => (
    <a
      {...props}
      href={musicReleaseLinkHref(props.href ?? '', current)}
      className={action}
      target="_blank"
      rel="noopener"
      onClick={onNavigate}
    />
  );
  return (
    <div className="min-w-0 space-y-5" data-occurrence={`${row.holder}:${row.statementId}`}>
      <p className="text-sm text-muted-foreground">{m.music_release_occurrence_scope({}, o)}</p>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">{m.work_parts_relation({}, o)}</dt>
          <dd>
            <span lang={stream.label.lang ?? undefined}>{stream.label.text || stream.property}</span>
            <span className="block text-sm">{stream.property}</span>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{m.music_release_direction({}, o)}</dt>
          <dd>{stream.direction === 'forward' ? m.music_release_forward({}, o) : m.music_release_inverse({}, o)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{m.work_parts_holder({}, o)}</dt>
          <dd>
            {row.holder === page.identity.id ? (
              <span lang={page.identity.label.lang ?? undefined}>{page.identity.label.text || row.holder}</span>
            ) : summary?.id === row.holder ? (
              <span lang={summary.label?.language}>{summary.label?.value || row.holder}</span>
            ) : (
              row.holder
            )}
            <span className="block text-sm text-muted-foreground">{row.holder}</span>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{m.album_tracks_membership({}, o)}</dt>
          <dd>{row.statementId}</dd>
        </div>
        {summary ? (
          <div>
            <dt className="text-sm text-muted-foreground">{m.album_tracks_kind({}, o)}</dt>
            <dd lang={type?.lang ?? undefined}>{type?.text || summary.type}</dd>
          </div>
        ) : null}
      </dl>
      {targetHref ? (
        <Link href={targetHref}>{m.album_tracks_open({}, o)}</Link>
      ) : (
        <p role="status">{m.music_release_target_withheld({}, o)}</p>
      )}
      {statement ? (
        <>
          <section className="min-w-0 space-y-3" aria-label={m.music_release_assertion({}, o)}>
            <h4 className="font-semibold">{m.music_release_assertion({}, o)}</h4>
            <p className="text-sm text-muted-foreground">{m.music_release_assertion_scope({}, o)}</p>
            <p className="text-sm text-muted-foreground">{m.music_release_assertion_target({}, o)}</p>
            <CandidateValue
              snak={statement}
              // Only the admitted edition or this row's disclosed summary can name the assertion endpoint.
              related={assertionRelated}
              locale={locale}
            />
            <h5 className="font-medium">{m.music_release_qualifiers({}, o)}</h5>
            {!statement.qualifiers.length ? (
              <p>{m.music_release_qualifiers_absent({}, o)}</p>
            ) : (
              <dl className="space-y-3">
                {statement.qualifiers.map((snak, index) => (
                  <div key={index}>
                    <dt
                      className="text-sm text-muted-foreground"
                      lang={page.labels[snak.property.id]?.lang ?? undefined}
                    >
                      {page.labels[snak.property.id]?.text || m.work_parts_unresolved({}, o)}
                    </dt>
                    <dd>
                      <CandidateValue snak={snak} related={row.related} locale={locale} link={Link} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section className="min-w-0 space-y-3" aria-label={m.sources_citations({}, o)}>
            <h4 className="font-semibold">{m.sources_citations({}, o)}</h4>
            <p className="text-sm text-muted-foreground">{m.music_release_references_scope({}, o)}</p>
            {!statement.references.length ? (
              <p>{m.music_reader_source_unavailable({}, o)}</p>
            ) : (
              <ol className="min-w-0 space-y-3">
                {statement.references.map((reference, index) => (
                  <li
                    key={index}
                    className="min-w-0 rounded-lg border border-border p-3"
                    data-slot="music-release-reference"
                  >
                    <h5 className="font-medium">{m.music_release_reference_group({ number: index + 1 }, o)}</h5>
                    <dl className="mt-3 space-y-3">
                      {reference.parts.map((snak, part) => (
                        <div key={part}>
                          <dt
                            className="text-sm text-muted-foreground"
                            lang={page.labels[snak.property.id]?.lang ?? undefined}
                          >
                            {page.labels[snak.property.id]?.text || m.work_parts_unresolved({}, o)}
                          </dt>
                          <dd>
                            <CandidateValue snak={snak} related={row.related} locale={locale} link={Link} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <ValueExplanationEntry
            id={row.holder}
            title={row.holder === page.identity.id ? page.identity.label.text : summary?.label?.value ?? ''}
            statement={row.statementId}
            property={statement.property.id}
            context={current.address.context}
            locale={locale}
            returnTo={musicReleaseReturnHref(current)}
          />
          <section className="min-w-0 space-y-3" aria-label={m.music_release_accepting_meaning({}, o)}>
            <h4 className="font-semibold">{m.music_release_accepting_meaning({}, o)}</h4>
            <p className="text-sm text-muted-foreground">{m.music_release_accepting_scope({}, o)}</p>
            {historicalStatement(statement, page.digest) ? (
              <p role="status">{m.release_fidelity_historical({}, o)}</p>
            ) : null}
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground">{m.music_release_pinned_release({}, o)}</dt>
                <dd>{statement.rezics.release}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{m.music_release_current_release({}, o)}</dt>
                <dd>{page.digest}</dd>
              </div>
            </dl>
          </section>
        </>
      ) : (
        <p role="status">{m.work_parts_assertion_unavailable({}, o)}</p>
      )}
      <details className="min-w-0 rounded-lg border border-border p-3">
        <summary className={`${action} cursor-pointer`}>{m.catalogue_technical_details({}, o)}</summary>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="text-muted-foreground">{m.music_release_edition({}, o)}</dt>
            <dd>{page.identity.id}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m.music_release_context({}, o)}</dt>
            <dd>{page.public.subject.context}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m.work_parts_holder({}, o)}</dt>
            <dd>{row.holder}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{m.album_tracks_membership({}, o)}</dt>
            <dd>{row.statementId}</dd>
          </div>
          {summary ? (
            <div>
              <dt className="text-muted-foreground">{m.music_release_destination({}, o)}</dt>
              <dd>{summary.id}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted-foreground">{m.work_parts_relation({}, o)}</dt>
            <dd>{stream.key}</dd>
          </div>
          {statement ? (
            <>
              <div>
                <dt className="text-muted-foreground">{m.music_release_rank({}, o)}</dt>
                <dd>{statement.rank}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{m.music_release_revision({}, o)}</dt>
                <dd>{statement.rezics.revision}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </details>
      {correction === 'allowed' && row.holder === page.identity.id ? (
        <Link href={correctionHref}>{m.album_tracks_correction({}, o)}</Link>
      ) : (
        <p role="status">
          {correction === 'denied' && row.holder === page.identity.id
            ? m.correction_denied({}, o)
            : m.correction_actions_unavailable({}, o)}
        </p>
      )}
    </div>
  );
}
