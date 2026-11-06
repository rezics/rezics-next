import { useRef, useEffect, useCallback } from 'react';
import { ClassificationWindows } from '../../ratings/own-classifications/window-navigation';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useHistoryCurrentOrigin } from '../../library/history-current-origin';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import {
  executeClassificationIntent,
  reviewClassificationIntent,
  readOwnClassificationsForViewer,
  prepareOwnClassificationsVisit,
} from '../../ratings/own-classifications/actions';
import { useLibraryWorkspaceAdmission } from '../../library/library-workspace-admission';
import { OwnVotesDeparture, type OwnVotesDepartureControl } from '../../ratings/own-votes/departure';
import { useClassificationAddress } from '../../ratings/own-classifications/address';
import { ClassificationsReader } from '../../ratings/own-classifications/reader';
import {
  classificationFrontier,
  classificationSearch,
  OWN_CLASSIFICATIONS_OPERATION,
} from '../../ratings/own-classifications/inventory';

const operations = [OWN_CLASSIFICATIONS_OPERATION] as const;
export const Route = createFileRoute('/library/classification-assessments')({
  validateSearch: (input: Record<string, unknown>) => {
    const frontier = classificationFrontier(input);
    return frontier ? { ...input, ...classificationSearch(frontier) } : { invalidAddress: true };
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => prepareOwnClassificationsVisit({ data: 'invalidAddress' in deps ? { cursor: '' } : deps }),
  head: ({ match }) =>
    pageHead({ title: m.own_classifications_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ClassificationAssessmentsRoute,
});

function ClassificationAssessmentsRoute() {
  const initial = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const location = useLocation();
  const search = Route.useSearch();
  const locale = getLocale();
  const frontier = 'invalidAddress' in search ? null : classificationFrontier(search);
  const address = useClassificationAddress(frontier, locale);
  const admission = useLibraryWorkspaceAdmission(operations).value;
  const origin = useHistoryCurrentOrigin(address.key, operations, initial.subject);
  const owner = JSON.stringify([origin.subject, admission.viewer, admission.dispatch[0], locale]);
  const retained = useRef({ owner, windows: new ClassificationWindows(), initial, address: address.key });
  if (retained.current.owner !== owner) {
    retained.current.windows.retire();
    retained.current = { owner, windows: new ClassificationWindows(), initial, address: address.key };
  }
  const windows = retained.current.windows;
  if (retained.current.initial !== initial) {
    // Loader preparation for deliberate movement is expected; same-address replacement is not movement.
    if (retained.current.address === address.key && !windows.staged) windows.retire();
    retained.current.initial = initial;
  }
  retained.current.address = address.key;
  const departureControl = useRef<OwnVotesDepartureControl | null>(null);
  useEffect(() => {
    const cancelFocus = () => {
      windows.focus = false;
    };
    document.addEventListener('focusin', cancelFocus);
    return () => {
      document.removeEventListener('focusin', cancelFocus);
      windows.retire();
    };
  }, [windows]);
  const read = useCallback(
    (original: import('../../ratings/own-classifications/types').ClassificationFrontier, signal?: AbortSignal) =>
      readOwnClassificationsForViewer({ data: classificationSearch(original), ...(signal ? { signal } : {}) }),
    [],
  );
  const state = !frontier
    ? 'invalid-address'
    : origin.session.state === 'signed-out'
      ? 'signed-out'
      : admission.rejected || (origin.authoritative && origin.retained[0] && !admission.allowed[0])
        ? 'denied'
        : null;
  return (
    <ClassificationsReader
      key={JSON.stringify([origin.lifetime(0), origin.epoch(0)])}
      initial={initial}
      windows={windows}
      frontier={frontier ?? { cursor: null, selected: null }}
      locale={locale}
      subject={origin.subject}
      state={state}
      isCurrent={() => address.isCurrent() && origin.current(0)}
      read={read}
      onNext={(next, keyboard) => {
        if (!address.isCurrent() || !origin.current(0)) return;
        windows.stage(next, keyboard ?? false);
        void navigate({
          search: (current) => {
            const updated: Record<string, unknown> = { ...current };
            delete updated.cursor;
            delete updated.selectedSubjectId;
            delete updated.selectedAssociationId;
            return { ...updated, ...classificationSearch(next) };
          },
          hash: location.hash,
        });
      }}
      commands={{
        confirmMovement: {
          get current() {
            return departureControl.current?.confirm ?? null;
          },
        },
        csrfToken: () => origin.credential(0) ?? null,
        send: (intent, signal) =>
          executeClassificationIntent({ data: intent, signal, headers: { 'x-csrf-token': intent.csrfToken } }),
        review: (intent, signal) =>
          reviewClassificationIntent({ data: intent, signal, headers: { 'x-csrf-token': intent.csrfToken } }),
        departure: (dirty, locked, current, retire) => (
          <OwnVotesDeparture
            dirty={dirty}
            locked={locked}
            isCurrent={current}
            onLeave={retire}
            confirmMovement={departureControl}
          />
        ),
      }}
    />
  );
}
