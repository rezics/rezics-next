import type { BundledPluginEntries, BundledPluginId, GameSessionObserver } from '@rezics/launcher-contract';
import { createGameFootprints } from './game-footprints.ts';
import { createLaunchDiagnostics } from './launch-diagnostics.ts';
import { createMinecraftPlugin, type MinecraftPluginOptions } from './minecraft-plugin.ts';
import { createVisualNovelPlugin, type VisualNovelPluginOptions } from './visual-novel-plugin.ts';

type BuiltinBackendEntries = {
  [Id in BundledPluginId]: BundledPluginEntries[Id] &
    (BundledPluginEntries[Id]['manifest']['observesGameSessions'] extends true
      ? { prepareGameSession: GameSessionObserver }
      : { prepareGameSession?: never });
};

export function createBuiltinPlugins(
  options: MinecraftPluginOptions & {
    instanceDirectory: (id: string) => string;
    visualNovels: VisualNovelPluginOptions;
  },
) {
  return {
    minecraft: createMinecraftPlugin(options),
    'launch-diagnostics': createLaunchDiagnostics(options.instanceDirectory),
    'visual-novel': createVisualNovelPlugin(options.visualNovels),
    'game-footprints': createGameFootprints(options.dataDir),
  } satisfies BuiltinBackendEntries;
}

export async function prepareGameSession(
  plugins: ReturnType<typeof createBuiltinPlugins>,
  subjectId: string | undefined,
) {
  const preparations = Object.values(plugins).flatMap((entry) =>
    'prepareGameSession' in entry ? [Promise.resolve().then(() => entry.prepareGameSession(subjectId))] : [],
  );
  const prepared = await Promise.allSettled(preparations);
  return prepared.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
}
