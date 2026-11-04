import { useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { useSession } from '../../session/query';
import { readQuestionManagementForViewer } from './actions';
import type {
  ManagementQuestion,
  QuestionManagementAddress,
  QuestionManagementPageData,
  QuestionManagementRead,
  QuestionManagementVisit,
} from './types';

type PageAddress = Omit<QuestionManagementAddress, 'realmId'>;

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function grainLabel(grain: 'work' | 'release' | 'episode' | 'character') {
  switch (grain) {
    case 'work':
      return m.home_question_work();
    case 'release':
      return m.home_question_release();
    case 'episode':
      return m.home_question_episode();
    case 'character':
      return m.home_question_character();
  }
}

export function QuestionManagementInspection({
  question,
  onHeading,
}: {
  question: ManagementQuestion;
  onHeading?: (node: HTMLHeadingElement | null) => void;
}) {
  return (
    <section className="space-y-4 rounded-2xl border p-4 sm:p-6" aria-labelledby="realm-question-selected-heading">
      <h2 ref={onHeading} tabIndex={-1} id="realm-question-selected-heading" className="text-xl font-semibold">
        {m.home_presentation_question_information()}
      </h2>
      <h3 className="break-words text-lg font-medium">{question.label}</h3>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1 sm:col-span-2">
          <dt className="text-sm font-medium text-muted-foreground">{m.realm_question_management_meaning()}</dt>
          <dd className="break-words whitespace-pre-wrap">{question.meaning}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-sm font-medium text-muted-foreground">{m.home_question_label()}</dt>
          <dd className="break-words whitespace-pre-wrap">{question.canonicalLabel}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-sm font-medium text-muted-foreground">
            {m.realm_question_management_definition_revision({ revision: String(question.revision) })}
          </dt>
          <dd>{grainLabel(question.grain)}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-sm font-medium text-muted-foreground">
            {m.realm_question_management_caption_revision({ revision: String(question.labelRevision) })}
          </dt>
          <dd className="break-words whitespace-pre-wrap">{question.label}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-sm font-medium text-muted-foreground">
            {m.realm_question_management_lifecycle_revision({ revision: String(question.lifecycle.revision) })}
          </dt>
          <dd>
            {question.lifecycle.state === 'active'
              ? m.realm_question_management_active()
              : m.realm_question_management_retired()}
          </dd>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <dt className="text-sm font-medium text-muted-foreground">{m.realm_question_management_units()}</dt>
          <dd>
            {question.scale.min}–{question.scale.max};{' '}
            {m.realm_question_management_display_step({ step: String(question.scale.displayStep) })}
          </dd>
          <p className="text-sm text-muted-foreground">{m.realm_question_management_zero()}</p>
        </div>
      </dl>
    </section>
  );
}

export function QuestionManagementContent({
  page,
  address,
  onSelect,
  onNext,
  onSelectedHeading,
}: {
  page: QuestionManagementPageData;
  address: PageAddress;
  onSelect: (questionId: string) => void;
  onNext: (cursor: string) => void;
  onSelectedHeading?: (node: HTMLHeadingElement | null) => void;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 text-foreground sm:px-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{m.realm_question_management_link()}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">{m.home_question_help()}</p>
      </header>

      <section className="space-y-4" aria-labelledby="realm-question-directory-heading">
        <h2 id="realm-question-directory-heading" className="text-xl font-semibold">
          {m.home_question_all()}
        </h2>
        {page.directory.ratingQuestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.home_questions_empty()}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {page.directory.ratingQuestions.map((question) => (
              <li key={question.id}>
                <button
                  type="button"
                  aria-current={address.selectedQuestionId === question.id ? 'page' : undefined}
                  className="w-full rounded-xl border p-4 text-start hover:bg-muted focus-visible:outline focus-visible:outline-2"
                  onClick={() => onSelect(question.id)}
                >
                  <span className="block font-medium">{question.label}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {m.home_question_metadata({
                      label: question.label,
                      revision: String(question.revision),
                      grain: grainLabel(question.grain),
                      min: String(question.scale.min),
                      max: String(question.scale.max),
                      step: String(question.scale.displayStep),
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {page.directory.next ? (
          <button type="button" className="rounded-md border px-4 py-2" onClick={() => onNext(page.directory.next!)}>
            {m.home_questions_next()}
          </button>
        ) : null}
      </section>

      {page.selected ? (
        <QuestionManagementInspection
          question={page.selected.question}
          {...(onSelectedHeading ? { onHeading: onSelectedHeading } : {})}
        />
      ) : null}
    </div>
  );
}

export function QuestionManagementPage({
  initial,
  address,
  locale,
  navigate,
}: {
  initial: QuestionManagementVisit;
  address: PageAddress | null;
  locale: string;
  navigate: (search: { selectedQuestionId?: string; cursor?: string }) => void;
}) {
  const session = useSession();
  const [read, setRead] = useState<QuestionManagementRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sessionCurrent, setSessionCurrent] = useState<boolean | null>(null);
  const generation = useRef(0);
  const selectedHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let alive = true;
    setSessionCurrent(null);
    if (session.state !== 'signed-in' || !session.subject || !session.csrfToken || !initial.csrfEpisode) {
      setSessionCurrent(false);
      return () => {
        alive = false;
      };
    }
    void digest(session.csrfToken).then((episode) => {
      if (alive)
        setSessionCurrent(
          session.subject === initial.viewer &&
            episode === initial.csrfEpisode &&
            initial.locale === locale &&
            initial.state === 'preparing',
        );
    });
    return () => {
      alive = false;
    };
  }, [initial, locale, session.csrfToken, session.state, session.subject]);

  useEffect(() => {
    const readGeneration = ++generation.current;
    const controller = new AbortController();
    if (!address || initial.state !== 'preparing' || sessionCurrent !== true) {
      setRead(null);
      setBusy(false);
      return () => {
        controller.abort();
      };
    }
    setBusy(true);
    setRead(null);
    void readQuestionManagementForViewer({
      data: {
        address: { realmId: initial.realmId, ...address },
        visit: initial,
      },
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted || generation.current !== readGeneration) return;
        if (result.state === 'ready' && result.page.viewer.accountId !== result.viewer) {
          setRead({ ...result, state: 'retired' });
          return;
        }
        setRead(result);
      })
      .catch(() => {
        if (!controller.signal.aborted && generation.current === readGeneration)
          setRead({
            realmId: initial.realmId,
            selectedQuestionId: initial.selectedQuestionId,
            cursor: initial.cursor,
            locale,
            viewer: initial.viewer,
            state: 'unavailable',
          });
      })
      .finally(() => {
        if (!controller.signal.aborted && generation.current === readGeneration) setBusy(false);
      });
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [address, initial, locale, retry, sessionCurrent]);

  useEffect(() => {
    if (read?.state === 'ready' && address?.selectedQuestionId) selectedHeading.current?.focus();
  }, [address?.selectedQuestionId, read]);

  const select = (questionId: string) => {
    navigate({ selectedQuestionId: questionId });
  };
  const restart = () => {
    navigate(address?.selectedQuestionId ? { selectedQuestionId: address.selectedQuestionId } : {});
  };
  const next = (cursor: string) => {
    navigate({
      ...(address?.selectedQuestionId ? { selectedQuestionId: address.selectedQuestionId } : {}),
      cursor,
    });
  };

  if (!address || initial.state === 'invalid-address')
    return <p role="alert">{m.home_questions_invalid()}</p>;
  if (session.state === 'signed-out' || read?.state === 'signed-out' || initial.state === 'signed-out')
    return <p role="status">{m.own_classifications_signed_out()}</p>;
  if (session.state === 'unknown' || sessionCurrent === null || busy || (initial.state === 'preparing' && !read))
    return <p role="status">{m.home_questions_loading()}</p>;
  if (sessionCurrent === false || read?.state === 'retired')
    return <p role="status">{m.own_classifications_stale()}</p>;
  if (initial.state === 'unavailable' || !read || read.state !== 'ready') {
    const staleCursor = read?.state === 'stale-cursor';
    const denied = read?.state === 'denied';
    return (
      <section className="space-y-3" aria-live="polite">
        <p role="status">
          {staleCursor ? m.home_questions_restart() : denied ? m.home_questions_denied() : m.home_questions_unavailable()}
        </p>
        <div className="flex flex-wrap gap-3">
          {staleCursor ? (
            <button type="button" className="rounded-md border px-4 py-2" onClick={restart}>
              {m.home_questions_restart_action()}
            </button>
          ) : (
            <button type="button" className="rounded-md border px-4 py-2" onClick={() => setRetry((value) => value + 1)}>
              {m.home_questions_retry()}
            </button>
          )}
        </div>
      </section>
    );
  }

  const { page } = read;
  return (
    <QuestionManagementContent
      page={page}
      address={address}
      onSelect={select}
      onNext={next}
      onSelectedHeading={(node) => {
        selectedHeading.current = node;
      }}
    />
  );
}
