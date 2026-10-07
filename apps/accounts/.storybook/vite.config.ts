import { defineConfig } from 'vite';

// Stories use the browser component runtime. Loading the app config would also
// load vinext's server and Workers plugins; main.ts adds the story plugins instead.
export default defineConfig({});
