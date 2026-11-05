import { loadConfigFromFile, type ConfigEnv, type UserConfig } from 'vite';
import { join } from 'node:path';

/** Load the production Web config through Vite so config factories receive their real ConfigEnv. */
export async function resolveWebViteConfig(env: ConfigEnv, appRoot: string): Promise<UserConfig> {
  const configFile = join(appRoot, 'vite.config.ts');
  const loaded = await loadConfigFromFile(env, configFile, appRoot, 'silent', undefined, 'bundle');
  if (!loaded) throw new Error(`Unable to load production Web Vite config: ${configFile}`);
  return loaded.config;
}
