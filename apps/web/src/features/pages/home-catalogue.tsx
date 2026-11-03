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
        <p role="status">{m.subject_section_failed({}, o)}</p>
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
