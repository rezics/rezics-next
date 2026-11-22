import { createFileRoute, notFound } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { KnowledgePrivatePage } from '../../knowledge/private-page';
import { parseKnowledgePrivateSubjectSearch } from '../../knowledge/private-knowledge';
import { ProgressPicker, type ProgressPickerSubject } from '../../library/progress-picker';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { PageHeading } from '../../shell/page-heading';

export const Route = createFileRoute('/knowledge/new')({
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  validateSearch(search: Record<string, unknown>): { subjectId?: string } {
    if (search.subjectId === undefined) return {};
    return { subjectId: typeof search.subjectId === 'string' ? search.subjectId : '' };
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => {
    if (deps.subjectId === undefined) return null;
    const parsed = parseKnowledgePrivateSubjectSearch(deps);
    if (!parsed) throw notFound();
    return parsed;
  },
  head: ({ match }) =>
    pageHead(
      { title: m.knowledge_private_create_kind(), robots: 'noindex, nofollow' },
      pageHeadContext(match.pathname),
    ),
  component: KnowledgePrivateNewRoute,
});

function KnowledgePrivateNewRoute() {
  const subject = Route.useLoaderData();
  return subject ? <KnowledgePrivatePage address={{ kind: 'create', ...subject }} /> : <ChooseSubject />;
}

function ChooseSubject() {
  const navigate = Route.useNavigate();
  const [selected, setSelected] = useState<ProgressPickerSubject[]>([]);
  return (
    <section className="mx-auto w-full max-w-3xl space-y-6">
      <header className="space-y-2 border-b border-border pb-5">
        <p className="text-sm text-muted-foreground">{m.knowledge_workspace_only_you()}</p>
        <PageHeading>{m.knowledge_private_create_kind()}</PageHeading>
      </header>
      <form
        className="grid max-w-xl gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const subjectId = selected[0]?.id;
          if (subjectId) void navigate({ search: { subjectId } });
        }}
      >
        <h2 className="text-lg font-semibold">{m.search_label()}</h2>
        <ProgressPicker label={m.search_label()} value={selected} onValueChange={setSelected} />
        <Button type="submit" className="min-h-11 justify-self-start" disabled={!selected.length}>
          {m.knowledge_private_choose_notebook()}
        </Button>
      </form>
    </section>
  );
}
