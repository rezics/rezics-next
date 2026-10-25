// The browser entry point runs the same checker synchronously without workers or I/O.
declare module 'recheck/lib/browser.js' {
  export { checkSync } from 'recheck';
}
