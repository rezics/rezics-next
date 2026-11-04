import type { ComponentProps, MouseEvent } from 'react';
import { m } from '../../../paraglide/messages.js';
import { CandidateValue } from '../../pages/data';
import { subjectHref } from '../../../subject/subject-href';
import { contextHref } from '../../pages/context-navigation';
import { historicalStatement } from '../release-fidelity/model';
import { profileSourceRecords } from '../music-reader';
import { musicReleaseDate, type MusicReleaseRead } from './model';

type Ready = Extract<MusicReleaseRead, { ok: true }>;
const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center break-words underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
export function MusicReleaseFacts({
  page,
  locale,
  realm,
  onNavigate,
}: {
  page: Ready;
  locale: string;
  realm?: string | undefined;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const o = { locale: locale as never };
  const base = contextHref(subjectHref({ id: page.identity.id, label: page.identity.label.text }, locale).href, realm);
  const sources = profileSourceRecords(page.public.subject);
  const Link = (props: ComponentProps<'a'>) => (
    <a
      {...props}
      className={action}
      href={contextHref(props.href ?? '', realm)}
      target="_blank"
      rel="noopener"
      onClick={onNavigate}
    />
  );
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
          {!page.facts.some((fact) => fact.kind === 'album') ? <p>{m.music_release_album_unavailable({}, o)}</p> : null}
          <dl className="space-y-4">
            {page.facts.map((fact) => (
              <div key={fact.property}>
                <dt className="font-semibold" lang={fact.label.lang ?? undefined}>
                  {fact.kind === 'album' ? `${m.music_release_album({}, o)} · ` : ''}
                  {fact.label.text || fact.property}
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
                      <div key={statement.id} className="space-y-2">
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
                                      {page.labels[snak.property.id]?.text || snak.property.id}
                                    </dt>
                                    <dd>
                                      <CandidateValue
                                        snak={snak}
                                        related={page.public.related}
                                        locale={locale}
                                        link={Link}
                                      />
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            ),
                          )}
                          <p className="text-sm">
                            {statement.id} · {statement.rank} · {statement.rezics.release}
                          </p>
                        </details>
                      </div>
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
      <Link href={`${base.split('?')[0]}/details`}>{m.music_release_generic({}, o)}</Link>
      <Link href={`${base.split('?')[0]}/edit`}>{m.music_release_correct({}, o)}</Link>
    </div>
  );
}
