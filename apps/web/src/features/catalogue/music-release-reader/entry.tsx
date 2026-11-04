import { loadMusicRelease } from './actions';
import { MusicReleaseReader } from './view';
import type { MusicReleaseTransport } from './model';
/** The route owns source recovery; this entry supplies the private no-store native transport. */
const transport: MusicReleaseTransport = (data) => loadMusicRelease({ data });
export function MusicReleaseOverview(props: Omit<Parameters<typeof MusicReleaseReader>[0], 'transport'>) {
  return <MusicReleaseReader {...props} transport={transport} />;
}
