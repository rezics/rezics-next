process.env.CONTENT_NOTIFICATION_DRIVER = new URL('./notification-driver.ts', import.meta.url).href;
await import('../../../../specs/content-notification-outcomes.test.ts');
