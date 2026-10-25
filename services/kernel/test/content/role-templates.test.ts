import { expect, test } from 'bun:test';
import { resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';

test('mounted actions resolve the content board, thread and post standing role templates', async () => {
  const pool = createPool('postgres://kernel.invalid/content-role-templates');
  try {
    const app = createKernel({ pool, routeKey: new Uint8Array(32) });
    const actions = actionCatalogue(app);
    expect(actions.get('report:create')).toEqual({ anonymous: true });
    expect(actions.get('reaction:set')).toEqual({ anonymous: false });
    expect(actions.get('moderation:read_reports')).toEqual({ anonymous: false });
    const resolved = resolveResourceRoles(actions);
    expect(resolved.types.get('content.board')).toEqual({
      owner: 'content.board.owner',
      standing: ['content.board.standing'],
    });
    expect(resolved.roles.get('content.board.standing')).toEqual(['report:create', 'thread:create']);
    expect(resolved.types.get('content.thread')).toEqual({
      owner: 'content.thread.owner',
      standing: ['content.thread.standing'],
    });
    expect(resolved.roles.get('content.thread.standing')).toEqual([
      'media:create',
      'post:create',
      'reaction:set',
      'report:create',
    ]);
    expect(resolved.types.get('content.post')).toEqual({
      owner: 'content.post.owner',
      standing: ['content.post.standing'],
    });
    expect(resolved.roles.get('content.post.standing')).toEqual(['reaction:set', 'report:create']);
    expect(resolved.types.get('content.report')).toEqual({ standing: [] });
  } finally {
    await pool.end();
  }
});
