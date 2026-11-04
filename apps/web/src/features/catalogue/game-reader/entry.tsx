import { loadGameReader } from './actions';
import { GameReader } from './view';
import type { GameReaderTransport } from './model';
const transport: GameReaderTransport = (data) => loadGameReader({ data });
export function GameOverview(props: Omit<Parameters<typeof GameReader>[0], 'transport'>) {
  return <GameReader {...props} transport={transport} />;
}
