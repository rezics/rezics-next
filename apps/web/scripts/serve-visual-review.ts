import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serveStorybook } from './screenshots';

const { values } = parseArgs({ options: { port: { type: 'string', default: '6006' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port from 1 to 65535.');

const directory = resolve(import.meta.dir, '../../../.temp/visual-review/site');
const site = serveStorybook(directory, port);
console.log(`Open http://127.0.0.1:${site.port}/?path=/story/route-review--application-route`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void site.close());
