import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { useMemo } from 'react';
import { MusicContextProfile } from '../../pages/music-context-profile';
import type { MusicContextTransport } from '../../pages/music-context-reading/view';
import type { MusicContextAddress } from './navigation';
import { readSubjectMusicContext } from './actions';

export const MusicContextSession = candidateSession(function MusicContextSessionLive({
  id,
  locale,
  context,
  realm,
  returnTo,
  via,
  stream,
  cursor,
  onAddressChange,
}: {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  returnTo?: string | undefined;
  via?: string | undefined;
  stream?: string | undefined;
  cursor?: string | undefined;
  onAddressChange?: ((address: MusicContextAddress & { stream: string }) => void) | undefined;
}) {
  const work = useCatalogueLifetime(
    JSON.stringify(['music-context', id, locale, context ?? '', realm ?? '', returnTo ?? '', via ?? '']),
  );
  const { state } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
  const transport = useMemo<MusicContextTransport>(
    () => ({
      read: (next: MusicContextAddress & { session?: string | undefined }) =>
        readSubjectMusicContext({
          data: {
            id,
            locale,
            ...(context !== undefined ? { context } : {}),
            expectedReader,
            stream: next.stream,
            cursor: next.cursor,
            session: next.session,
          },
          headers: csrfHeaders(),
        }),
    }),
    [context, expectedReader, id, locale],
  );
  if (state === 'unknown') return <p>{m.music_context_loading({}, { locale: locale as never })}</p>;
  return (
    <MusicContextProfile
      id={id}
      locale={locale}
      context={context}
      realm={realm}
      returnTo={returnTo}
      via={via}
      initialStream={stream}
      initialCursor={cursor}
      onAddressChange={onAddressChange}
      transport={transport}
    />
  );
});
