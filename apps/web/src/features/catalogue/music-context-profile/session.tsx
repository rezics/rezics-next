import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { MusicContextProfile } from '../../pages/music-context-profile';
import { readSubjectMusicContext } from './actions';

export const MusicContextSession = candidateSession(function MusicContextSessionLive({
  id,
  locale,
  returnTo,
}: {
  id: string;
  locale: string;
  returnTo?: string | undefined;
}) {
  const work = useCatalogueLifetime('music-context');
  const { state } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
  if (state === 'unknown') return <p>{m.music_context_loading({}, { locale: locale as never })}</p>;
  return (
    <MusicContextProfile
      id={id}
      locale={locale}
      returnTo={returnTo}
      transport={{
        read: (next) =>
          readSubjectMusicContext({
            data: { id, locale, expectedReader, stream: next.stream, cursor: next.cursor, session: next.session },
            headers: csrfHeaders(),
          }),
      }}
    />
  );
});
