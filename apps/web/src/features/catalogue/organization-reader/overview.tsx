import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PeopleRead } from '../people-profile';
import type { PageLink } from '../../pages/shared';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { m } from '../../../paraglide/messages.js';
import { organizationCurrent, type OrganizationCurrent } from './index';
import { OrganizationReader } from './view';

export type OrganizationRead = (id: string, signal: AbortSignal) => Promise<PeopleRead>;
const productionRead: OrganizationRead = async (id, signal) => {
  const { loadPeopleProfile } = await import('../people-profile-actions');
  return loadPeopleProfile({ data: { id }, signal });
};

/** One fresh ordinary read per composition observation; no private editor, polling or row hydration. */
export function OrganizationOverview({
  id,
  context,
  source,
  locale,
  reader,
  realm,
  link,
  read = productionRead,
}: {
  id: string;
  context: string;
  source: object;
  locale: string;
  reader: string | null;
  realm?: string | undefined;
  link?: PageLink | undefined;
  read?: OrganizationRead;
}) {
  const reading = useSubjectCommunityReading({
    source,
    descriptor: JSON.stringify([id, context, locale, realm]),
    reader,
  });
  const [result, setResult] = useState<{ source: object; key: string; read: OrganizationCurrent | undefined }>();
  const [retry, setRetry] = useState(0);
  const region = useRef<HTMLElement>(null);
  const focused = useRef(false);
  const current = useRef(reading);
  current.current = reading;
  useEffect(() => {
    setResult(undefined);
    if (!reading.available) return;
    const controller = new AbortController();
    const observation = current.current;
    void read(id, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && observation.isCurrent())
          setResult({ source, key: observation.key, read: organizationCurrent(value, id, context) });
      },
      () => {
        if (!controller.signal.aborted && observation.isCurrent())
          setResult({ source, key: observation.key, read: undefined });
      },
    );
    return () => controller.abort();
  }, [id, context, source, locale, reading.key, reading.available, read, retry]);
  const visible = result?.source === source && result.key === reading.key && reading.available ? result : undefined;
  useLayoutEffect(() => {
    if (!visible?.read && focused.current) {
      region.current?.focus();
      focused.current = false;
    }
  }, [visible]);
  const o = { locale: locale as never };
  return (
    <section
      ref={region}
      tabIndex={-1}
      aria-label={m.organization_reader_title({}, o)}
      className="min-w-0 space-y-3"
      onFocusCapture={() => {
        focused.current = true;
      }}
      onBlurCapture={(event) => {
        focused.current = !!event.relatedTarget && !!region.current?.contains(event.relatedTarget);
      }}
    >
      {visible?.read ? (
        <OrganizationReader
          read={visible.read}
          source={source}
          locale={locale}
          reader={reader}
          realm={realm}
          {...(link ? { link } : {})}
        />
      ) : (
        <>
          <h2 className="text-xl font-semibold">{m.organization_reader_title({}, o)}</h2>
          <p role="status">
            {reading.available && !visible ? m.candidate_loading({}, o) : m.organization_reader_unavailable({}, o)}
          </p>
          {reading.available && visible && (
            <button
              type="button"
              className="min-h-11 min-w-11 underline"
              onClick={() => {
                if (current.current.isCurrent()) setRetry((value) => value + 1);
              }}
            >
              {m.correction_retry({}, o)}
            </button>
          )}
        </>
      )}
    </section>
  );
}
