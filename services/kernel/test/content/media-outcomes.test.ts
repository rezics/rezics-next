process.env.CONTENT_MEDIA_DRIVER = new URL('./media-driver.ts', import.meta.url).href;

await import('../../../../specs/content-media-outcomes.test.ts');
