import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { CatalogueReportsVisit, catalogueReportsSearch } from '../../moderation/catalogue-reports-page';

export const Route = createFileRoute('/moderation/catalogue')({
  validateSearch: catalogueReportsSearch,
  component: CatalogueReportsRoute,
});

function CatalogueReportsRoute() {
  const { cursor } = Route.useSearch();
  const navigate = useNavigate({ from: '/moderation/catalogue' });
  const next = useCallback(
    (value: string) => void navigate({ search: (previous) => ({ ...previous, cursor: value }) }),
    [navigate],
  );
  const restart = useCallback(
    () => void navigate({ search: (previous) => ({ ...previous, cursor: undefined }) }),
    [navigate],
  );
  return <CatalogueReportsVisit key={cursor ?? 'first-page'} cursor={cursor} onNext={next} onRestart={restart} />;
}
