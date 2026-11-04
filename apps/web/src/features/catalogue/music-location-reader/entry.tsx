import { csrfHeaders } from '../../../threads/composer';
import { readSubjectMusicLocation } from './actions';
import type { MusicLocationTransport } from './model';
import { MusicLocationReader, type MusicLocationReaderProps } from './view';

const transport =
  (locale: string, expectedReader: string | null): MusicLocationTransport =>
  (address) =>
    readSubjectMusicLocation({ data: { ...address, locale, expectedReader }, headers: csrfHeaders() });

export function MusicLocationOverview({
  locale,
  reader,
  ...props
}: Omit<MusicLocationReaderProps, 'transport' | 'locale' | 'reader'> & {
  locale: string;
  reader: string | null;
}) {
  return (
    <MusicLocationReader
      {...props}
      locale={locale}
      reader={reader}
      transport={transport(locale, reader)}
    />
  );
}
