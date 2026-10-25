import { expect, test } from 'bun:test';
import { resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';

test('mounted report actions enable the content thread, post and media role templates', async () => {
  const pool = createPool('postgres://kernel.invalid/content-role-templates');
  try {
    const app = createKernel({ pool, routeKey: new Uint8Array(32) });
    const actions = actionCatalogue(app);
    expect(actions.get('report:create')).toEqual({ anonymous: true });
    expect(actions.get('moderation:read_reports')).toEqual({ anonymous: false });
    const resolved = resolveResourceRoles(actions);
    for (const type of ['content.thread', 'content.post', 'content.media']) {
      expect(resolved.types.has(type)).toBe(true);
    }
    expect(resolved.types.get('content.report')).toEqual({ standing: [] });
  } finally {
    await pool.end();
  }
});
