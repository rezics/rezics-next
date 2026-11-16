import { beforeAll } from 'bun:test';
import './cloudflare-workers-shim.ts';

// Component files install their DOM before application imports capture browser-only reading policy.
// Keep the installed semantic adapter real, but bind it after those file-level fixture prerequisites.
beforeAll(async () => {
  const [{ pageRenderBinding }, { installSemanticRenderPort }] = await Promise.all([
    import('../../src/features/catalogue/page-render-binding'),
    import('../../src/features/pages/subject-page-application'),
  ]);
  installSemanticRenderPort(pageRenderBinding);
});
