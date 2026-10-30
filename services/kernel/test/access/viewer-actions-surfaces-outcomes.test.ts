process.env.VIEWER_ACTIONS_SURFACES_DRIVER = new URL('./viewer-actions-surfaces-driver.ts', import.meta.url).href;
await import('../../../../specs/viewer-actions-surfaces-outcomes.test.ts');
