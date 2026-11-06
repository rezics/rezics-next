import { createFileRoute } from '@tanstack/react-router';
import { DefinitionPublicationWorkspace } from '../../features/catalogue/definition-publication/workspace';
import {
  createDefinitionPublicationSubject,
  openDefinitionPublication,
  previewDefinitionPublication,
  publicationAddress,
  readDefinitionPublicationBuild,
  readDefinitionPublicationExtension,
  readDefinitionPublicationRelease,
  readDefinitionPublicationSubject,
  submitDefinitionPublication,
} from '../../features/catalogue/definition-publication/actions';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/catalogue/definitions_/publish')({
  staticData: { publicCache: false },
  validateSearch: publicationAddress,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => openDefinitionPublication({ data: deps }),
  head: ({ match }) =>
    pageHead({ title: m.definition_publication_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: PublicationRoute,
});

function PublicationRoute() {
  const address = Route.useSearch();
  const initial = Route.useLoaderData();
  const locale = getLocale();
  return (
    <DefinitionPublicationWorkspace
      locale={locale}
      scope={address.scope}
      initial={initial}
      {...(address.context ? { context: address.context } : {})}
      transport={{
        open: (scope, context) => openDefinitionPublication({ data: { scope, ...(context ? { context } : {}) } }),
        preview: (document, context, expectedHead) =>
          previewDefinitionPublication({
            data: {
              document,
              ...(context ? { context } : {}),
              ...(expectedHead === undefined ? {} : { expectedHead }),
            },
          }),
        submit: (command) => submitDefinitionPublication({ data: command }),
        readRelease: (digest) => readDefinitionPublicationRelease({ data: digest }),
        readExtension: (context, digest) => readDefinitionPublicationExtension({ data: { context, digest } }),
        readBuild: (root) => readDefinitionPublicationBuild({ data: root }),
        createSubject: (type, key) => createDefinitionPublicationSubject({ data: { type, key } }),
        readSubject: (id) => readDefinitionPublicationSubject({ data: id }),
      }}
    />
  );
}
