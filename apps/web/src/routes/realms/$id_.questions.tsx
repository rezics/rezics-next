import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { m } from '../../paraglide/messages.js';
import { prepareQuestionManagementVisit } from '../../ratings/question-management/actions';
import { useQuestionManagementAddress } from '../../ratings/question-management/address';
import { QuestionManagementPage } from '../../ratings/question-management/page';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { getLocale } from '../../paraglide/runtime.js';
import { requireSignedIn } from '../../session/guard';
import { browserObservation, type BrowserObservationSnapshot } from '../../session/observation';
import type { QuestionManagementVisit } from '../../ratings/question-management/types';
import type { QuestionManagementFocusTicket } from '../../ratings/question-management/types';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Search = { selectedQuestionId?: string; cursor?: string; invalidAddress?: true };

const sourceIds = new WeakMap<object, number>();
let nextSourceId = 0;
function sourceId(source: object) {
  let id = sourceIds.get(source);
  if (id === undefined) {
    id = ++nextSourceId;
    sourceIds.set(source, id);
  }
  return id;
}

function searchAddress(input: Record<string, unknown>): Search {
  const selectedQuestionId = input.selectedQuestionId;
  const cursor = input.cursor;
  if (
    (selectedQuestionId !== undefined &&
      (typeof selectedQuestionId !== 'string' || !idPattern.test(selectedQuestionId))) ||
    (cursor !== undefined && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 4096))
  )
    return { invalidAddress: true };
  return {
    ...(typeof selectedQuestionId === 'string' ? { selectedQuestionId } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
  };
}

export const Route = createFileRoute('/realms/$id_/questions')({
  beforeLoad: requireSignedIn,
  validateSearch: searchAddress,
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }): Promise<QuestionManagementVisit> => {
    if (!idPattern.test(params.id) || 'invalidAddress' in deps)
      return {
        realmId: params.id,
        selectedQuestionId: null,
        cursor: null,
        locale: getLocale(),
        viewer: null,
        credentialEpisode: null,
        csrfEpisode: null,
        state: 'invalid-address',
      };
    return prepareQuestionManagementVisit({
      data: {
        realmId: params.id,
        ...('selectedQuestionId' in deps ? { selectedQuestionId: deps.selectedQuestionId } : {}),
        ...('cursor' in deps ? { cursor: deps.cursor } : {}),
      },
    });
  },
  head: ({ match }) =>
    pageHead(
      { title: m.realm_question_management_link(), robots: 'noindex, nofollow' },
      pageHeadContext(match.pathname),
    ),
  component: QuestionManagementRoute,
});

function QuestionManagementRoute() {
  const initial = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const locale = getLocale();
  const client = useQueryClient();
  const router = useRouter({ warn: false });
  const sessionStore = useMemo(() => browserObservation(client), [client]);
  const sessionObservation = useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSnapshot,
    sessionStore.getServerSnapshot,
  );
  const address = useMemo(
    () =>
      'invalidAddress' in search
        ? null
        : {
            selectedQuestionId: search.selectedQuestionId ?? null,
            cursor: search.cursor ?? null,
          },
    [search.invalidAddress, search.selectedQuestionId, search.cursor],
  );
  const addressOrigin = useQuestionManagementAddress(initial.realmId, address, locale);
  const currentSessionObservation = useCallback(
    () => sessionStore.getSnapshot() === sessionObservation && sessionObservation.state === 'signed-in',
    [sessionStore, sessionObservation],
  );
  const focusEpoch = useRef(0);
  const focusId = useRef(0);
  const focusTicketRef = useRef<QuestionManagementFocusTicket | null>(null);
  const [focusTicket, setFocusTicket] = useState<QuestionManagementFocusTicket | null>(null);
  const pendingSelection = useRef<string | null>(null);
  const updateFocusTicket = (ticket: QuestionManagementFocusTicket | null) => {
    focusTicketRef.current = ticket;
    setFocusTicket(ticket);
  };
  const interruptFocus = () => {
    focusEpoch.current++;
    pendingSelection.current = null;
    if (focusTicketRef.current) updateFocusTicket(null);
  };
  const isFocusTicketCurrent = (ticket: QuestionManagementFocusTicket) =>
    focusTicketRef.current === ticket && focusEpoch.current === ticket.focusEpoch;
  const consumeFocusTicket = (ticket: QuestionManagementFocusTicket) => {
    if (!isFocusTicketCurrent(ticket)) return false;
    updateFocusTicket(null);
    return true;
  };
  useLayoutEffect(() => {
    const pointerDown = () => interruptFocus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') interruptFocus();
    };
    const focusIn = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== document.documentElement) interruptFocus();
    };
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('focusin', focusIn, true);
    const unsubscribe = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      const pending = pendingSelection.current;
      if (pending && toLocation.search.selectedQuestionId === pending) {
        pendingSelection.current = null;
        return;
      }
      interruptFocus();
    });
    return () => {
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('focusin', focusIn, true);
      unsubscribe();
    };
  }, [router]);
  const navigateSearch = (next: { selectedQuestionId?: string; cursor?: string }) => {
    const pending = pendingSelection.current;
    if (!pending || next.selectedQuestionId !== pending) interruptFocus();
    void navigate({ search: next });
  };
  const selectQuestion = (questionId: string) => {
    const alreadySelected = address?.selectedQuestionId === questionId;
    const ticket = {
      id: ++focusId.current,
      questionId,
      focusEpoch: focusEpoch.current,
      afterRead: 0,
    } satisfies QuestionManagementFocusTicket;
    pendingSelection.current = alreadySelected ? null : questionId;
    updateFocusTicket(ticket);
    if (!alreadySelected) navigateSearch({ selectedQuestionId: questionId });
  };
  const captureFocusEpoch = () => focusEpoch.current;
  const acknowledgeFocus = (questionId: string | null, expectedEpoch: number, afterRead: number) => {
    if (
      !questionId ||
      focusEpoch.current !== expectedEpoch ||
      !currentSessionObservation() ||
      !addressOrigin.isCurrent()
    )
      return;
    const ticket = {
      id: ++focusId.current,
      questionId,
      focusEpoch: expectedEpoch,
      afterRead,
    } satisfies QuestionManagementFocusTicket;
    pendingSelection.current = address?.selectedQuestionId === questionId ? null : questionId;
    updateFocusTicket(ticket);
  };
  return (
    <QuestionManagementPage
      key={JSON.stringify([
        sourceId(initial),
        initial.realmId,
        initial.viewer,
        initial.credentialEpisode,
        initial.csrfEpisode,
        locale,
        address,
        addressOrigin.key,
        sessionObservation.state === 'signed-in' ? sessionObservation.observation.id : sessionObservation.state,
      ])}
      initial={initial}
      address={address}
      locale={locale}
      navigate={navigateSearch}
      onSelectQuestion={selectQuestion}
      sessionObservation={sessionObservation}
      isSessionObservationCurrent={currentSessionObservation}
      addressKey={addressOrigin.key}
      isAddressCurrent={addressOrigin.isCurrent}
      focusTicket={focusTicket}
      isFocusTicketCurrent={isFocusTicketCurrent}
      consumeFocusTicket={consumeFocusTicket}
      captureFocusEpoch={captureFocusEpoch}
      acknowledgeFocus={acknowledgeFocus}
    />
  );
}
