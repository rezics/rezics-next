import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { browserObservation } from '../../../session';
import { m } from '../../../paraglide/messages.js';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { CharacterWorkRows } from '../character-work-visit/view';
import {
  characterWorkStream,
  useCharacterPage,
  useCharacterReadingSlots,
  type CharacterConnectionRead,
  type CharacterConnectionWindow,
  type CharacterPage,
} from '../character-reading-port';
import { CharacterAssociationContext } from './bridge';

const groups = ['characters', 'credits'] as const;
const noSubscribe = () => () => {};
const noBinding = () => undefined;
const action = 'inline-flex min-h-11 min-w-11 items-center py-2 underline focus-visible:outline-2';

export type CharacterAssociations = { source: object; viewer: string | null; read?: CharacterConnectionRead };

/** A local presentation of the two existing native windows, with no document or per-row reader. */
export function CharacterPublicReading({ source, viewer, read }: CharacterAssociations) {
  const value = useCharacterPage();
  const { read: readSlot } = useCharacterReadingSlots();
  const bridge = useContext(CharacterAssociationContext);
  const binding = useSyncExternalStore(bridge?.subscribe ?? noSubscribe, bridge?.snapshot ?? noBinding, noBinding);
  const descriptor = JSON.stringify([
    value?.subject,
    value?.context,
    value?.realm,
    value?.locale,
    value?.reader,
    value?.releaseDigest,
    viewer,
  ]);
  const lifetime = useSubjectCommunityReading({ source, reader: viewer, descriptor });
  const owned = useRef<{
    source: object;
    descriptor: string;
    read: CharacterConnectionRead;
    serial: number;
    window: CharacterConnectionWindow;
  } | null>(null);
  if (!value?.subject) return null;
  if (!lifetime.available) {
    if (!bridge) owned.current?.window.retire(true);
    return <p role="status">{m.character_work_unavailable({}, { locale: value.locale as never })}</p>;
  }
  if (bridge)
    return binding?.source === source ? (
      <AssociationWindows window={binding.window} value={value} viewer={viewer} managed />
    ) : (
      <p role="status">{m.subject_relation_loading({}, { locale: value.locale as never })}</p>
    );
  if (!read) return null;
  if (
    !owned.current ||
    owned.current.source !== source ||
    owned.current.descriptor !== descriptor ||
    owned.current.read !== read
  ) {
    owned.current?.window.retire(true);
    owned.current = {
      source,
      descriptor,
      read,
      serial: (owned.current?.serial ?? 0) + 1,
      window: readSlot.createWindow(
        {
          id: value.subject,
          locale: value.locale,
          context: value.context?.id,
          realm: value.realm,
          release: value.releaseDigest,
          ...(viewer ? { viewer } : {}),
        },
        read,
      ),
    };
  }
  return <AssociationWindows key={owned.current.serial} window={owned.current.window} value={value} viewer={viewer} />;
}

function AssociationWindows({
  window,
  value,
  viewer,
  managed = false,
}: {
  window: CharacterConnectionWindow;
  value: CharacterPage;
  viewer: string | null;
  managed?: boolean;
}) {
  const client = useContext(QueryClientContext);
  const { read: readSlot } = useCharacterReadingSlots();
  const [retired, setRetired] = useState(false);
  const snapshot = useSyncExternalStore(window.subscribe, window.snapshot, window.snapshot);
  const heading = useRef<HTMLDivElement>(null);
  const focus = useRef<EventTarget | null>(null);
  const o = { locale: value.locale as never };
  useLayoutEffect(() => {
    if (!managed) window.activate();
    const observation = client ? browserObservation(client) : undefined;
    const disconnect = observation?.subscribe(() => {});
    const retire = () => {
      window.retire();
      setRetired(true);
    };
    const stop = observation?.subscribeRetirement(retire);
    const current = observation?.getSnapshot();
    if (
      current?.state === 'signed-in'
        ? current.observation.subject !== viewer
        : viewer !== null && current?.state === 'signed-out'
    ) {
      retire();
      return () => {
        stop?.();
        disconnect?.();
      };
    }
    if (!managed) void window.load();
    return () => {
      stop?.();
      disconnect?.();
      if (!managed) window.retire(true);
    };
  }, [window, client, viewer, managed]);
  useLayoutEffect(() => {
    if (focus.current instanceof Element && !focus.current.isConnected && document.activeElement === document.body)
      heading.current?.focus();
  }, [snapshot]);
  return (
    <div
      ref={heading}
      tabIndex={-1}
      className="min-w-0 space-y-6"
      data-slot="character-public-reading"
      onFocusCapture={(event) => {
        focus.current = event.target;
      }}
    >
      {retired ? (
        <p role="status">{m.character_work_unavailable({}, o)}</p>
      ) : snapshot.failure ? (
        <div role="status">
          <p>{m.character_work_unavailable({}, o)}</p>
          <button
            className={action}
            onClick={() => {
              void window.restart();
            }}
          >
            {m.subject_relation_restart({}, o)}
          </button>
        </div>
      ) : (
        groups.map((group) => {
          const current = snapshot.visit?.sections[group];
          const kind = current ? characterWorkStream(current.stream, value.subject!) : undefined;
          const busy = snapshot.pending.has('initial') || snapshot.pending.has(group);
          const section = current?.section;
          const page = snapshot.pages?.[group];
          return (
            <section key={group} className="min-w-0 space-y-3" aria-busy={busy}>
              <h3 className="text-xl font-semibold">
                {group === 'characters' ? m.character_work_appearances({}, o) : m.character_work_performances({}, o)}
              </h3>
              {busy ? (
                <p role="status">{m.subject_relation_loading({}, o)}</p>
              ) : current && kind && section?.ok ? (
                <>
                  <CharacterWorkRows
                    current={current}
                    value={value}
                    kind={kind}
                    returnWindow={readSlot.connectionReturn(current, page)}
                  />
                  {Array.isArray(section.body.links) && !section.body.links.length && (
                    <p role="status">{m.subject_relation_empty_page({}, o)}</p>
                  )}
                  <nav className="flex flex-wrap gap-4">
                    {page && page.index > 0 && (
                      <button
                        className={action}
                        onClick={() => {
                          void window.previous(group);
                        }}
                      >
                        {m.subject_connections_previous({}, o)}
                      </button>
                    )}
                    {typeof section.body.next === 'string' && (
                      <button
                        className={action}
                        onClick={() => {
                          void window.next(group);
                        }}
                      >
                        {m.subject_connections_next({}, o)}
                      </button>
                    )}
                    <button
                      className={action}
                      onClick={() => {
                        void window.restartGroup(group);
                      }}
                    >
                      {m.subject_relation_restart({}, o)}
                    </button>
                  </nav>
                </>
              ) : (
                <div role="status">
                  <p>{m.character_work_unavailable({}, o)}</p>
                  {current && (
                    <button
                      className={action}
                      onClick={() => {
                        void window.restartGroup(group);
                      }}
                    >
                      {m.subject_relation_restart({}, o)}
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
