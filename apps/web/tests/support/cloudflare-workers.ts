import { mock } from 'bun:test';

// `cloudflare:workers` only resolves inside the Workers runtime. Test files import it first so the mock is in place
// before a static import reaches a module that reads the runtime environment.
mock.module('cloudflare:workers', () => ({ env: {} }));
