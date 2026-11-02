import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { readLabelsCurrent } from '../../library/labels-read-route';
import { LabelsCurrent } from '../../library/labels-current';
import { parseLabelsAddress } from '../../library/labels-address';
import { LabelsAddressRecovery } from '../../library/labels-address-recovery';
import type { LabelsCurrentRead } from '../../library/labels-read-route';
import { getLocale } from '../../paraglide/runtime.js';
import { labelsFormPost } from '../../library/labels-actions';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/library/labels')({
  server: { handlers: { POST: labelsFormPost } },
  validateSearch: (search: Record<string, unknown>) => ({
    ...(Object.hasOwn(search, 'cursor') ? { cursor: search.cursor } : {}),
    ...(Object.hasOwn(search, 'q') ? { q: search.q } : {}),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor, query: search.q }),
  loader: async ({ deps }) => {
    const address = parseLabelsAddress(deps);
    if (!address.valid) return { kind: 'invalid-address' as const, address };
    const result = await readLabelsCurrent({
      data: { cursor: address.cursor ?? undefined, query: address.query ?? undefined },
    });
    return { kind: 'loaded' as const, address, result };
  },
  head: ({ match }) =>
    pageHead({ title: m.library_labels_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: LabelsRoute,
});

function LabelsRoute() {
  const data = Route.useLoaderData();
  if (data.kind === 'invalid-address')
    return (
      <LabelsAddressRecovery
        issue={data.address.issue}
        query={data.address.query}
        rawQuery={data.address.rawQuery}
        rawCursor={data.address.rawCursor}
      />
    );
  return (
    <LabelsCurrent
      initial={data.result as LabelsCurrentRead}
      search={{
        ...(data.address.cursor === null ? {} : { cursor: data.address.cursor }),
        ...(data.address.query === null ? {} : { q: data.address.query }),
      }}
      locale={getLocale()}
    />
  );
}
