process.env.VIEWER_ACTIONS_DRIVER = new URL('./viewer-actions-outcomes-driver.ts', import.meta.url).href;
await import('../../../../specs/viewer-actions-outcomes.test.ts');
