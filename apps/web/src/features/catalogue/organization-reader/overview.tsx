import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import type { PeopleRead } from '../people-profile';
import { PlainLink, type PageLink } from '../../pages/shared';
import { subjectHref } from '../../../subject/subject-href';
import { defaultReader, type Reader } from '../../../subject/reader';
import { m } from '../../../paraglide/messages.js';
import { organizationAdmission, organizationCurrent, type OrganizationCurrent } from './index';
import { OrganizationReader } from './view';
import { useOrganizationEpisode } from './reading/episode';

export type OrganizationRead = (id: string, signal: AbortSignal) => Promise<PeopleRead>;
const productionRead: OrganizationRead = async (id, signal) => {
  const { loadPeopleProfile } = await import('../people-profile-actions');
  return loadPeopleProfile({ data: { id }, signal });
};

type Settlement = { operation: object; value?: OrganizationCurrent | undefined; failed: boolean };

/** Prefer the composition/release pair. A fallback read can never borrow its document representations. */
export function OrganizationOverview({
  id,
  context,
  source,
  locale,
  reader,
  realm,
  link: Link = PlainLink,
  public: composed,
  release,
  documents,
  preferences = defaultReader,
  currentHref,
  returnTo,
  read = productionRead,
}: {
  id: string;
  context: string;
  source: object;
  locale: string;
  reader: string | null;
  realm?: string | undefined;
  link?: PageLink | undefined;
  public?: SubjectRead | undefined;
  release?: Pick<Release, 'types' | 'properties'> | undefined;
  documents?: unknown;
  preferences?: Reader;
  currentHref?: string | undefined;
  returnTo?: string | undefined;
  read?: OrganizationRead;
}) {
  const { episode, available } = useOrganizationEpisode(
    source,
    JSON.stringify([id, context, locale, realm, preferences.spoilerLevel, preferences.suitability]),
    reader,
  );
  const admitted = useMemo(
    () =>
      composed && release && organizationAdmission({ public: composed, release }, id, context)
        ? { public: composed, release }
        : undefined,
    [composed, release, id, context],
  );
  const [attempt, setAttempt] = useState(0);
  const operation = useMemo(() => ({}), [episode, attempt, read, admitted]);
  const [settled, setSettled] = useState<Settlement>();
  const pendingFocus = useRef<{ operation: object; cancelled: boolean } | undefined>(undefined);
  const region = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef({ episode, operation });
  live.current = { episode, operation };
  useEffect(() => {
    if (!available || admitted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    episode.signal.addEventListener('abort', abort, { once: true });
    const owns = () => !controller.signal.aborted && episode.current() && live.current.operation === operation;
    void read(id, controller.signal).then(
      (value) => {
        if (owns()) {
          const current = organizationCurrent(value, id, context);
          setSettled({ operation, value: current, failed: !current });
        }
      },
      () => {
        if (owns()) setSettled({ operation, failed: true });
      },
    );
    return () => {
      controller.abort();
      episode.signal.removeEventListener('abort', abort);
    };
  }, [id, context, episode, available, admitted, operation, read]);
  const result = available && settled?.operation === operation ? settled : undefined;
  const value = available ? (admitted ?? result?.value) : undefined;
  const failed = available && !value && !!result?.failed;
  const pending = available && !value && !failed;
  const href = currentHref ?? subjectHref({ id, label: '' }, locale).href;
  const o = { locale: locale as never };
  useLayoutEffect(() => {
    if (pending) return;
    const intent = pendingFocus.current;
    pendingFocus.current = undefined;
    if (intent?.operation === operation && !intent.cancelled && episode.current())
      (heading.current ?? region.current?.querySelector<HTMLElement>('h2'))?.focus();
  }, [pending, operation, episode]);
  useEffect(() => {
    const cancel = () => {
      if (pendingFocus.current) pendingFocus.current.cancelled = true;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    return () => {
      cancel();
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
    };
  }, []);
  // The operation token changes synchronously with Retry, before any old promise can settle into it.
  const retryIntent = useRef(false);
  useLayoutEffect(() => {
    if (retryIntent.current) {
      pendingFocus.current = { operation, cancelled: false };
      retryIntent.current = false;
    }
  }, [operation]);
  return (
    <section ref={region} aria-label={m.organization_reader_title({}, o)} className="min-w-0 space-y-3">
      {value ? (
        <OrganizationReader
          read={value}
          source={source}
          locale={locale}
          reader={reader}
          realm={realm}
          link={Link}
          documents={admitted ? documents : undefined}
          preferences={preferences}
          currentHref={href}
          returnTo={returnTo}
        />
      ) : (
        <>
          <h2
            ref={heading}
            tabIndex={-1}
            className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-ring"
          >
            {m.organization_reader_title({}, o)}
          </h2>
          <p role="status" aria-live="polite">
            {pending
              ? m.candidate_loading({}, o)
              : failed
                ? m.organization_reader_failed({}, o)
                : m.organization_reader_unavailable({}, o)}
          </p>
          {failed && (
            <button
              type="button"
              className="min-h-11 min-w-11 underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                if (!episode.current() || live.current.operation !== operation || retryIntent.current) return;
                retryIntent.current = true;
                setAttempt((value) => value + 1);
              }}
            >
              {m.correction_retry({}, o)}
            </button>
          )}
          {!pending && (
            <a
              className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
              href={href}
            >
              {m.organization_reader_refresh({}, o)}
            </a>
          )}
        </>
      )}
    </section>
  );
}
