import { useRef } from 'react';
import { useRouter } from '@tanstack/react-router';
import { csrfHeaders } from '../../../threads/composer';
import { readSubjectMusicLocation } from './actions';
import type { MusicLocationTransport } from './model';
import { MusicLocationReader, type MusicLocationReaderProps } from './view';

const transport =
  (locale: string, expectedReader: string | null): MusicLocationTransport =>
  (address) =>
    readSubjectMusicLocation({ data: { ...address, locale, expectedReader }, headers: csrfHeaders() });

type Recovery = {
  identity: string;
  source: object | string;
  admittedSource?: object | string;
  stream?: string | undefined;
};

/** Reload the existing route's admitted Subject without reconstructing its local region URL. */
export function MusicLocationOverview({
  locale,
  reader,
  ...props
}: Omit<MusicLocationReaderProps, 'transport' | 'locale' | 'reader' | 'refresh' | 'restoreStream'> & {
  locale: string;
  reader: string | null;
}) {
  const router = useRouter();
  const recovery = useRef<Recovery | undefined>(undefined);
  const identity = JSON.stringify([props.subject.subject.id, props.context, locale, reader, props.realm]);
  let restoreStream: string | undefined;
  const saved = recovery.current;
  if (saved && saved.identity !== identity) recovery.current = undefined;
  else if (saved && saved.source !== props.source) {
    saved.admittedSource ??= props.source;
    if (saved.admittedSource === props.source) restoreStream = saved.stream;
    else recovery.current = undefined;
  }
  const refresh = async (stream?: string) => {
    recovery.current = { identity, source: props.source, stream };
    // Invalidation reruns the real loader, retaining cursor, Realm/node context and the full URL.
    // The route remains responsible for the existing signed-out/private admission rule.
    await router.invalidate({ sync: true });
  };
  return (
    <MusicLocationReader
      {...props}
      locale={locale}
      reader={reader}
      transport={transport(locale, reader)}
      refresh={refresh}
      restoreStream={restoreStream}
    />
  );
}
