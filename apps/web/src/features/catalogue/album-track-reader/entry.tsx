import { loadAlbumTracks } from './actions';
import { AlbumTrackReader } from './view';
import type { AlbumTrackTransport } from './model';
const transport: AlbumTrackTransport = (data) => loadAlbumTracks({ data });
export function AlbumTrackOverview(props: Omit<Parameters<typeof AlbumTrackReader>[0], 'transport'>) {
  return <AlbumTrackReader {...props} transport={transport} />;
}
