import type { AccessClient } from '../request/access.ts';
import type { WorkContext } from '../work/registry.ts';

/** One atomic bounded installation/catch-up step. Never called by a permission/roster request. */
export async function advanceCurrentResourceRoles(client: AccessClient): Promise<number> {
  const result = await client.query<{ touched: number }>('SELECT access.advance_current_resource_roles() AS touched');
  return result.rows[0]!.touched;
}

/** Default Access maintenance; no environment opt-in or separate installer. Durable progress lives in Access. */
export function registerCurrentResourceRolesWork(context: WorkContext): void {
  context.addService(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> = Promise.resolve();
    const tick = () => {
      pending = (async () => {
        let touched = 0;
        try {
          touched = await advanceCurrentResourceRoles(context.pool);
        } catch (error) {
          console.error('Current resource role upkeep failed', error);
        }
        if (!stopped) timer = setTimeout(tick, touched === 100 ? 10 : 1000);
      })();
    };
    timer = setTimeout(tick, 0);
    return {
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await pending;
      },
    };
  });
}
