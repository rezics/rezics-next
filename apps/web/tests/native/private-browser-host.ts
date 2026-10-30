import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

const [portText, socketPath] = process.argv.slice(2);
const port = Number(portText);
if (!portText || !socketPath || !Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write('Usage: bun private-browser-host.ts <port> <bridge-socket>\n');
  process.exit(2);
}

const interfaces = Object.keys(networkInterfaces()).sort();
if (interfaces.length !== 1 || interfaces[0] !== 'lo') {
  process.stderr.write(`Private browser requires only loopback; found ${interfaces.join(', ') || 'none'}\n`);
  process.exit(1);
}

const maxRequestBytes = 4 * 1024 * 1024;
const maxResponseBytes = 16 * 1024 * 1024;
const server = createServer((request, response) => {
  if (
    request.url === '/__native_ready' ||
    new URL(request.url ?? '/', `http://${request.headers.host}`).pathname === '/__native_ready'
  ) {
    response.writeHead(204).end();
    return;
  }
  void forward(request, response).catch((error) => {
    if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
    else response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('Private bridge failed');
  });
});
server.on('connect', (_request, socket) => {
  socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
});
server.listen(port, '127.0.0.1');

async function forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const target = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  if (target.protocol !== 'http:') {
    response.writeHead(400).end('Only local HTTP origins are supported');
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxRequestBytes) {
      response.writeHead(413).end('Request exceeds private bridge bound');
      return;
    }
    chunks.push(buffer);
  }
  const headers: [string, string][] = [];
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      ['connection', 'host', 'keep-alive', 'proxy-connection', 'transfer-encoding'].includes(name)
    )
      continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.push([name, item]);
  }
  const payload = Buffer.from(
    JSON.stringify({
      url: target.href,
      method: request.method ?? 'GET',
      headers,
      body: Buffer.concat(chunks).toString('base64'),
    }),
  );
  if (payload.length > maxRequestBytes) {
    response.writeHead(413).end('Request exceeds private bridge bound');
    return;
  }

  const bridge = connect(socketPath);
  const chunksFromBridge: Buffer[] = [];
  let responseSize = 0;
  bridge.on('data', (chunk) => {
    responseSize += chunk.length;
    if (responseSize > Math.ceil((maxResponseBytes * 4) / 3) + 1024 * 1024)
      bridge.destroy(new Error('Response exceeds private bridge bound'));
    else chunksFromBridge.push(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    bridge.once('error', reject);
    bridge.once('connect', () => bridge.end(payload));
    bridge.once('end', () => resolve());
  });
  const result = JSON.parse(Buffer.concat(chunksFromBridge).toString('utf8')) as {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: string;
  };
  const body = Buffer.from(result.body, 'base64');
  if (body.length > maxResponseBytes) {
    response.writeHead(502).end('Response exceeds private bridge bound');
    return;
  }
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of result.headers) {
    const key = name.toLowerCase();
    if (['connection', 'content-encoding', 'content-length', 'keep-alive', 'transfer-encoding'].includes(key)) continue;
    if (key === 'set-cookie') {
      const previous = output[key];
      output[key] = [...(Array.isArray(previous) ? previous : previous ? [previous] : []), value];
    } else if (output[key] !== undefined) output[key] = `${output[key]}, ${value}`;
    else output[key] = value;
  }
  output['content-length'] = String(body.length);
  response.writeHead(result.status, result.statusText, output).end(body);
}
