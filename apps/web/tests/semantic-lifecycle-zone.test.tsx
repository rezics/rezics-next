import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZoneLifecycleControls } from '../src/features/catalogue/lifecycle-zone.tsx';
import {
  changeZoneLifecycle,
  changeZoneTakedown,
  type ZoneLifecycleClient,
  type ZoneLifecycleResult,
} from '../src/features/catalogue/lifecycle-zone-commands.ts';

test('owner delete and restore map native status without leaking configuration', async () => {
  const calls: { method: string; path: string }[] = [];
  const client: ZoneLifecycleClient = {
    zones(input) {
      return {
        async delete() {
          calls.push({ method: 'DELETE', path: `/v1/zones/${input.id}` });
          return { status: 200, data: { zone: { revision: '2' } } };
        },
        $restore: {
          async post() {
            calls.push({ method: 'POST', path: `/v1/zones/${input.id}:restore` });
            return { status: 200, data: { zone: { revision: '3' } } };
          },
        },
      };
    },
  };
  const deleted = await changeZoneLifecycle(client, 'Bearer owner', {
    id: '018f1a2b-3c4d-7000-8000-000000000001',
    revision: '1',
    key: '11111111-1111-4111-8111-111111111111',
    operation: 'delete',
  });
  const restored = await changeZoneLifecycle(client, 'Bearer owner', {
    id: '018f1a2b-3c4d-7000-8000-000000000001',
    revision: '2',
    key: '22222222-2222-4222-8222-222222222222',
    operation: 'restore',
  });
  expect(deleted).toEqual({ ok: true, operation: 'delete', revision: '2' });
  expect(restored).toEqual({ ok: true, operation: 'restore', revision: '3' });
  expect(calls.map((call) => call.method)).toEqual(['DELETE', 'POST']);
  expect(JSON.stringify([deleted, restored])).not.toContain('configuration');
});

test('moderator takedown maps denial and the controls stay usable on a narrow layout', async () => {
  const denied = await changeZoneTakedown(
    {
      zones() {
        return {
          async delete() {
            return { status: 500, data: null };
          },
          $restore: {
            async post() {
              return { status: 500, data: null };
            },
          },
          $takedown: {
            async post() {
              return { status: 403, data: null };
            },
          },
        };
      },
    },
    'Bearer owner',
    {
      id: '018f1a2b-3c4d-7000-8000-000000000001',
      revision: '1',
      key: '11111111-1111-4111-8111-111111111111',
      pointers: ['/labels/en'],
      operation: 'takedown',
    },
  );
  expect(denied).toEqual({ ok: false, reason: 'denied' });
  const last: ZoneLifecycleResult = denied;
  const markup = renderToStaticMarkup(
    <div className="max-w-xs">
      <ZoneLifecycleControls deleted={false} withheld last={last} busy={false} onDelete={() => {}} onRestore={() => {}} />
    </div>,
  );
  expect(markup).toContain('Not allowed');
  expect(markup).toContain('Delete zone');
});
