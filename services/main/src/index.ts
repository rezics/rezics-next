import { createMainApp } from './app.ts';
import { FusekiClient } from './infrastructure/fuseki.ts';

const fusekiUrl = Bun.env.FUSEKI_URL;
if (!fusekiUrl) throw new Error('FUSEKI_URL is required');
const port = Number(Bun.env.MAIN_PORT ?? '3001');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MAIN_PORT must be an integer TCP port');
}

createMainApp(new FusekiClient(fusekiUrl)).listen({ hostname: '127.0.0.1', port });
