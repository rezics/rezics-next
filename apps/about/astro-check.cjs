// Runs `astro check` on TypeScript 6 (the `typescript-6` alias in package.json). Its language service needs the JavaScript
// compiler API that TypeScript 7 (the native port the other workspaces use) does
// not ship, and the hoisted Volar packages would otherwise resolve TypeScript 7.
const Module = require('node:module');
const typescript = require.resolve('typescript-6', { paths: [__dirname] });
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request === 'typescript' ? typescript : request, ...rest);
};
// `exports` hides the package's bin, so import it by path from its entry point.
const path = require('node:path');
const entry = require.resolve('@astrojs/check', { paths: [__dirname] });
// The standalone checker skips Astro's CLI sync step. Generate collection and
// environment types first so a clean checkout checks the same types as a build.
import('astro')
  .then(async ({ sync }) => {
    await sync({});
    return import(path.join(path.dirname(entry), '..', 'bin', 'astro-check.js'));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
