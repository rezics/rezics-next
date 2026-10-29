import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.ts',
  mode: 'development',
  optimizeDeps: { disabled: true },
});
await server.close();
