import { useRouter } from '@tanstack/react-router';
import { loadGameReader } from './actions';
import { GameReader } from './view';
import type { GameReaderTransport } from './model';
const transport: GameReaderTransport = (data) => loadGameReader({ data });
export function GameOverview(props: Omit<Parameters<typeof GameReader>[0], 'transport' | 'refresh'>) {
  const router = useRouter();
  return (
    <GameReader
      {...props}
      transport={transport}
      refresh={async () => {
        await router.invalidate({ sync: true });
      }}
    />
  );
}
