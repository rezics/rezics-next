import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loopbackChromiumLaunch } from './chromium-loopback.ts';

test('loopback launch leaves remote origins alone', () => {
  expect(loopbackChromiumLaunch('https://example.com')).toEqual({});
});

test('Linux loopback launch keeps address snapshots without interface subscriptions', () => {
  if (process.platform !== 'linux') return;
  const directory = mkdtempSync(resolve('.temp/chromium-netlink-'));
  try {
    const source = `${directory}/probe.c`;
    writeFileSync(source, `#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <stdio.h>
#include <sys/socket.h>
int main(void) {
  int fd = socket(AF_NETLINK, SOCK_RAW, NETLINK_ROUTE);
  struct sockaddr_nl address = { .nl_family = AF_NETLINK, .nl_groups = RTMGRP_LINK | RTMGRP_IPV4_IFADDR | RTMGRP_IPV6_IFADDR };
  if (bind(fd, (struct sockaddr *)&address, sizeof(address))) return 1;
  socklen_t size = sizeof(address);
  if (getsockname(fd, (struct sockaddr *)&address, &size)) return 2;
  printf("%u %u", address.nl_pid, address.nl_groups);
  return 0;
}
`);
    const binary = `${directory}/probe`;
    const build = spawnSync('cc', ['-Wall', '-Wextra', '-Werror', '-o', binary, source], { encoding: 'utf8' });
    expect({ status: build.status, error: build.stderr }).toEqual({ status: 0, error: '' });
    const ordinary = spawnSync(binary, [], { encoding: 'utf8' });
    expect(ordinary.status).toBe(0);
    expect(Number(ordinary.stdout.split(' ')[1])).toBeGreaterThan(0);
    const stable = spawnSync(binary, [], { encoding: 'utf8', env: loopbackChromiumLaunch('http://127.0.0.1').env });
    expect(stable.status).toBe(0);
    const [pid, groups] = stable.stdout.split(' ').map(Number);
    expect(pid).toBeGreaterThan(0);
    expect(groups).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('loopback Chromium uses real document, RSC and API transports, including single command delivery and offline errors', async () => {
  const requests: { method: string; body: string; key: string | null }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push({ method: request.method, body: await request.text(), key: request.headers.get('idempotency-key') });
    if (new URL(request.url).pathname === '/api/status') return Response.json({ error: 'real refusal' }, { status: 403 });
    return new Response('<title>Loopback</title>', { headers: { 'content-type': 'text/html' } });
  } });
  const browser = await chromium.launch(loopbackChromiumLaunch(server.url.origin));
  try {
    const page = await browser.newPage();
    await page.goto(server.url.origin);
    await page.reload();
    expect(await page.title()).toBe('Loopback');
    expect(await page.evaluate(async () => {
      const response = await fetch('/api/status');
      return { status: response.status, body: await response.json() };
    })).toEqual({ status: 403, body: { error: 'real refusal' } });
    expect(await page.evaluate(async () => (await fetch('/?_rsc=read', { headers: { RSC: '1' } })).status)).toBe(200);
    await page.evaluate(async () => { await fetch('/api/shelf', { method: 'PUT', body: 'reading', headers: { 'idempotency-key': 'one-delivery' } }); });
    expect(requests.filter(request => request.method === 'PUT')).toEqual([{ method: 'PUT', body: 'reading', key: 'one-delivery' }]);
    await page.context().setOffline(true);
    expect(await page.evaluate(async () => {
      try { await fetch('/api/status'); return 'loaded'; } catch { return 'offline'; }
    })).toBe('offline');
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 30_000);
