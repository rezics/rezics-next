import { createFileRoute } from '@tanstack/react-router';
import { CatalogueFileCreateSession } from '../../features/catalogue/catalogue-file-create-session';
import { loadCatalogueFileCreate } from '../../features/catalogue/catalogue-file-create-actions';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/file')({
  staticData: { publicCache: false },
  loader: () => loadCatalogueFileCreate({ data: false }),
  head: () => ({
    meta: [{ title: m.catalogue_file_create_title() }, { name: 'robots', content: 'noindex, nofollow' }],
  }),
  component: () => <CatalogueFileCreateSession locale={getLocale()} initial={Route.useLoaderData()} />,
});
