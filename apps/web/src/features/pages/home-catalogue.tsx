import { m } from '../../paraglide/messages.js';
import { PageData } from './data';
import type { RoutePageLoad } from './route';
import { isRecord } from './shared';
import { TypeList } from './type-list';
import { SubjectLink, subjectPageMessages } from './route-support';

/** Keep the native Home plan and Search-owned TypeList admission, pagination and canonical destinations. */
export function HomeCatalogue({ result, locale }: { result?: RoutePageLoad | undefined; locale: string }) {
  const o = { locale: locale as never };
  const page = result?.kind === 'page' ? result.page : undefined;
  // These are the route's top-level catalogue slots, never a local search or imported seed manifest.
  const lists =
    page?.document.content.flatMap((node) =>
      isRecord(node) && node.type === 'TypeList' && isRecord(node.props) ? [node.props] : [],
    ) ?? [];
  const failure = result?.kind === 'rejected' || result?.kind === 'unavailable' ? result : undefined;
  return (
    <section aria-labelledby="home-catalogue" className="min-w-0 space-y-6">
      <h2 id="home-catalogue" className="text-2xl font-semibold">
        {m.home_catalogue({}, o)}
      </h2>
      {page && lists.length ? (
        <PageData
          locale={locale}
          subject={page.subject ?? null}
          document={page.document}
          reads={page.reads}
          messages={subjectPageMessages(locale)}
          link={SubjectLink}
          listTarget={{ route: '/' }}
          pageTarget={{ route: '/' }}
        >
          {lists.map((props) => (
            <TypeList key={props.id as string} {...props} />
          ))}
        </PageData>
      ) : (
        <div
          role={failure ? 'alert' : 'status'}
          data-home-catalogue-state={result?.kind ?? 'missing'}
          data-response-status={failure?.status ?? ''}
          data-response-code={failure?.code ?? ''}
          className="space-y-2"
        >
          <p>
            {result?.kind === 'unavailable'
              ? m.catalogue_result_read_unavailable({}, o)
              : m.subject_section_failed({}, o)}
          </p>
          {failure ? (
            <a href={`/${locale}`} className="text-primary underline underline-offset-4">
              {m.catalogue_retry_loading_result({}, o)}
            </a>
          ) : null}
        </div>
      )}
      <a
        href={`/${locale}/search`}
        className="inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.search_heading({}, o)}
      </a>
    </section>
  );
}

/** Stable public identity for the Home TypeList reads; private Library facts never enter this cache key. */
export function homeCatalogueObservation(result?: RoutePageLoad): string {
  if (result?.kind !== 'page') return JSON.stringify(['home-catalogue', result ?? { kind: 'missing' }]);
  const lists = result.page.document.content.flatMap((node) =>
    isRecord(node) && node.type === 'TypeList' && isRecord(node.props) && typeof node.props.id === 'string'
      ? [node.props.id]
      : [],
  );
  return JSON.stringify([
    result.page.route,
    result.page.profile,
    result.page.template,
    lists.map((id) => {
      const read = result.page.reads[id];
      const body = read?.body;
      const subjects = isRecord(body) && Array.isArray(body.subjects) ? body.subjects : [];
      return [
        id,
        read?.status ?? null,
        subjects.map((subject) =>
          isRecord(subject)
            ? [
                subject.id ?? null,
                subject.type ?? null,
                isRecord(subject.summary) ? subject.summary.creativeWork : null,
              ]
            : null,
        ),
      ];
    }),
  ]);
}
