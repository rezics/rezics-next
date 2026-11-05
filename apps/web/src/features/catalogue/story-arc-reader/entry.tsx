import { loadArcReader } from './actions';
import { StoryArcReader } from './view';
import type { ArcTransport } from './model';
const transport: ArcTransport = (data) => loadArcReader({ data });
export function StoryArcOverview(props: Omit<Parameters<typeof StoryArcReader>[0], 'transport'>) {
  return <StoryArcReader {...props} transport={transport} />;
}
