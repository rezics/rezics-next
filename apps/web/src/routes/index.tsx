import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { kernelClient } from '../kernel/client';
import { loadRoutePage, RoutePage } from '../features/pages/route';

const loadHome = createServerFn({ method: 'GET' }).handler(async () => loadRoutePage(kernelClient(), '/'));

export const Route = createFileRoute('/')({
  loader: () => loadHome(),
  head: () => ({ meta: [{ title: m.home_heading() }] }),
  component: Home,
});

function Home() {
  const loaded = Route.useLoaderData();
  if (loaded.kind === 'missing') return <h1 className="font-serif text-3xl">{m.home_heading()}</h1>;
  return (
    <RoutePage
      page={loaded.page}
      locale={getLocale()}
      messages={{
        unknown: m.subject_value_unknown(),
        none: m.subject_value_none(),
        unlabelled: m.subject_value_unlabelled(),
        sources: m.subject_sources(),
        aliases: m.subject_aliases(),
        search: m.search_submit(),
      }}
    />
  );
}
