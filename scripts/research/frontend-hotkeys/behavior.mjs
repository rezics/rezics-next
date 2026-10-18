import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { candidates } from './policy.mjs';

const base = resolve('.temp/frontend-hotkeys');
const captures = `${base}/captures`;
mkdirSync(captures, { recursive: true });
const result = { startedAt: new Date().toISOString(), mode: 'pinned Vinext development SSR + browser; not route-cost proof', candidates: {} };
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
function instrument() {
  window.__keyListeners = [];
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (type === 'keydown' || type === 'keyup') {
      const capture = typeof options === 'boolean' ? options : !!options?.capture;
      if (!window.__keyListeners.some(row => row.target === this && row.type === type && row.listener === listener && row.capture === capture))
        window.__keyListeners.push({ target: this, type, listener, capture });
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    window.__keyListeners = window.__keyListeners.filter(row => !(row.target === this && row.type === type && row.listener === listener && row.capture === capture));
    return remove.call(this, type, listener, options);
  };
  window.__cancels = 0;
  const prevent = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function() { if (this.type === 'keydown') window.__cancels++; return prevent.call(this); };
}

for (const candidate of candidates) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const chunks = [];
  const server = spawn('task', ['--taskfile', 'scripts/research/frontend-hotkeys/Taskfile.yml', 'fixture:dev', '--', '--port', String(port)],
    { env: { ...process.env, HOTKEY_CANDIDATE: candidate }, detached: true, stdio: ['ignore','pipe','pipe'] });
  server.stdout.on('data', data => chunks.push(data));
  server.stderr.on('data', data => chunks.push(data));
  const entry = { cases: [], console: [], errors: [] };
  result.candidates[candidate] = entry;
  let browser;
  try {
    let html;
    for (let n = 0; n < 100; n++) {
      if (server.exitCode !== null) throw new Error(`Fixture server exited ${server.exitCode}`);
      try { const response = await fetch(origin); if (response.ok) { html = await response.text(); break; } } catch { /* Startup only. */ }
      await sleep(250);
    }
    if (!html) throw new Error('Fixture server did not return successful SSR');
    writeFileSync(`${captures}/${candidate}-ssr.html`, html);
    entry.ssr = { status: html.includes('Keyboard comparison:') ? 'pass' : 'fail', bytes: Buffer.byteLength(html), browserGlobalsError: /ReferenceError: (window|document|navigator)/.test(html) };
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    entry.browser = browser.version();
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
    await context.addInitScript(instrument);
    const page = await context.newPage();
    page.on('pageerror', error => entry.errors.push(String(error)));
    page.on('console', message => { if (['error','warning'].includes(message.type())) entry.console.push(message.text()); });
    await page.goto(origin);
    await page.waitForFunction(() => window.__fixture && window.__adapter, undefined, { timeout: 60000 });
    const clear = async () => page.evaluate(() => { window.__fixture.clear(); window.__cancels = 0; });
    const state = async () => page.evaluate(() => ({ actions: window.__fixture.logs.map(row => row.id), cancels: window.__cancels,
      focus: document.activeElement?.id || document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName,
      registrations: window.__adapter.count(), listeners: window.__keyListeners.map(row => ({ type: row.type, capture: row.capture,
        target: row.target === window ? 'window' : row.target === document ? 'document' : row.target.nodeName,
        connected: row.target === window || row.target === document || row.target.isConnected })) }));
    async function vector(id, target, init, expected = [], expectedCancels = expected.length ? 1 : 0) {
      await clear();
      const before = await state();
      const event = await page.locator(target).evaluate((node, value) => {
        node.focus();
        const key = new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...value });
        node.dispatchEvent(key);
        node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true, ...value }));
        return { defaultPrevented: key.defaultPrevented, trusted: key.isTrusted };
      }, init);
      const after = await state();
      const actions = after.actions;
      entry.cases.push({ id, target, init, expected, actions, cancels: after.cancels,
        expectedCancels, status: JSON.stringify(actions) === JSON.stringify(expected) && after.cancels === expectedCancels ? 'pass' : 'fail',
        event, focus: after.focus, registrations: before.registrations });
      return after;
    }
    const search = candidate === 'native-as-is' ? 'input[type=search]' : '#fixture-search';
    await vector('keys-priority/page-search', '#page-target', { key:'k', code:'KeyK', ctrlKey:true }, ['search']);
    await vector('keys-priority/consumed', '#consumed', { key:'k', code:'KeyK', ctrlKey:true }, [], 1);
    await vector('keys-priority/editor-bold', '.tiptap', { key:'b', code:'KeyB', ctrlKey:true }, [], 1);
    entry.editorBold = await page.locator('#document-json').textContent();
    await vector('keys-priority/editor-link', '.tiptap', { key:'k', code:'KeyK', ctrlKey:true }, [], 1);
    entry.editorLink = { linkFieldVisible: await page.getByPlaceholder('https://example.com').count(),
      dialogCount: await page.getByRole('dialog').count() };
    await page.keyboard.press('Escape');
    for (const init of [
      { key:'k', code:'KeyK', ctrlKey:true, isComposing:true },
      { key:'k', code:'KeyK', ctrlKey:true, keyCode:229 },
      { key:'b', code:'KeyB', ctrlKey:true, isComposing:true },
      { key:'b', code:'KeyB', ctrlKey:true, keyCode:229 },
      { key:'Process', code:'KeyK', ctrlKey:true },
      { key:'Unidentified', code:'KeyK', ctrlKey:true },
    ]) await vector(`keys-ime/${init.key}/${init.isComposing ? 'composing' : init.keyCode || 'sentinel'}`, '#page-target', init);
    for (const target of ['#plain-input','#plain-textarea','#plain-select','.tiptap','#portal-input']) {
      await vector('keys-inputs/character', target, { key:'?', code:'Slash', shiftKey:true });
    }
    await vector('keys-inputs/altgr', '#page-target', { key:'k', code:'KeyK', ctrlKey:true, altKey:true });
    await vector('keys-inputs/dead', '#plain-input', { key:'Dead', code:'Quote' });
    await vector('keys-priority/repeat', '#page-target', { key:'b', code:'KeyB', ctrlKey:true, repeat:true });
    await page.getByRole('button', { name:'Open action menu', exact:true }).click();
    await page.getByRole('menuitem', { name:'Menu help' }).focus();
    await vector('keys-inputs/menu', '[role=menuitem]:first-child', { key:'?', code:'Slash', shiftKey:true }, [], 1);
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name:'Choose manuscript' }).click();
    await vector('keys-inputs/combobox', '[role=combobox]', { key:'?', code:'Slash', shiftKey:true });
    await page.keyboard.press('ArrowDown');
    entry.combobox = { highlighted: await page.getByRole('combobox', { name:'Choose manuscript' }).getAttribute('aria-activedescendant') };
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name:'Open trial modal', exact:true }).click();
    await page.locator('#modal-input').waitFor();
    await vector('keys-priority/modal-search', '#modal-input', { key:'k', code:'KeyK', ctrlKey:true });
    await vector('keys-priority/modal-sidebar', '#modal-input', { key:'b', code:'KeyB', ctrlKey:true });
    await page.getByLabel('Pending trial action').check();
    await page.keyboard.press('Escape');
    entry.pending = { status: await page.locator('#modal-input').isVisible() ? 'pass' : 'fail' };
    await page.getByLabel('Pending trial action').uncheck();
    await page.getByRole('button', { name:'Open nested modal', exact:true }).click();
    await page.getByLabel('Nested input').waitFor();
    entry.nested = { initialFocus: await page.getByLabel('Nested input').evaluate(node => document.activeElement === node) };
    await page.keyboard.press('Tab');
    entry.nested.focusContained = await page.evaluate(() => !!document.activeElement.closest('[role=dialog]'));
    await page.keyboard.press('Escape');
    entry.nested.parentSurvives = await page.locator('#modal-input').isVisible();
    await page.locator('#modal-input').dispatchEvent('keydown', { key:'Escape', code:'Escape', keyCode:229, isComposing:false });
    entry.imeDialog229 = { status: await page.locator('#modal-input').isVisible() ? 'pass' : 'fail' };
    if (await page.locator('#modal-input').isVisible()) await page.keyboard.press('Escape');
    entry.focusReturn = { focus: await page.evaluate(() => document.activeElement?.id), expected:'modal-trigger' };
    if (candidate !== 'native-as-is') {
      await page.getByLabel('Disable search and character shortcuts').check();
      await vector('keys-customization/disabled', '#page-target', { key:'k', code:'KeyK', ctrlKey:true });
      await page.getByRole('button',{ name:'Reset bindings' }).click();
      await page.getByLabel('Search binding', { exact:true }).fill('Mod+J');
      await page.getByRole('button',{ name:'Apply binding' }).click();
      await vector('keys-customization/remapped', '#page-target', { key:'j', code:'KeyJ', ctrlKey:true }, ['search']);
      await vector('keys-customization/old-binding', '#page-target', { key:'k', code:'KeyK', ctrlKey:true });
      entry.help = { text: await page.getByRole('region',{ name:'Shortcut help' }).textContent(),
        aria: await page.locator(search).getAttribute('aria-keyshortcuts') };
      await page.getByLabel('Search binding',{ exact:true }).fill('Mod+B');
      await page.getByRole('button',{ name:'Apply binding' }).click();
      entry.invalidRemap = { visible: await page.getByRole('status').first().textContent() };
      await page.getByRole('button',{ name:'Reset bindings' }).click();
      await page.getByLabel('Use G then H for help').check();
      await vector('keys-customization/sequence-prefix', '#page-target', { key:'g', code:'KeyG' });
      await vector('keys-customization/sequence-completion', '#page-target', { key:'h', code:'KeyH' }, ['navigation-help']);
      await page.getByLabel('Use G then H for help').uncheck();
    } else entry.customization = 'unavailable: current imported owners expose no remap/disable API; fixture controls cannot change them';
    entry.scales = [];
    for (const count of [5,50]) {
      await page.getByLabel('Registration count').selectOption(String(count));
      await page.waitForTimeout(100);
      const raw = await page.evaluate(() => {
        const batches = [];
        for (let round=0; round<3; round++) {
          const samples=[];
          for(let i=0;i<120;i++) {
            window.__fixture.clear();
            const target=document.querySelector('#page-target'); target.focus();
            const start=performance.now();
            target.dispatchEvent(new KeyboardEvent('keydown',{key:'k',code:'KeyK',ctrlKey:true,bubbles:true,cancelable:true}));
            target.dispatchEvent(new KeyboardEvent('keyup',{key:'k',code:'KeyK',ctrlKey:true,bubbles:true}));
            const actions=window.__fixture.logs;
            samples.push({ms:actions.find(row=>row.id==='search')?.at-start,actions:actions.map(row=>row.id)});
          }
          batches.push(samples);
        }
        return batches;
      });
      const values=raw.flat().filter(row=>Number.isFinite(row.ms)).map(row=>row.ms).sort((a,b)=>a-b);
      entry.scales.push({ count, observed:await state(), samples:raw,
        p50:values[Math.floor(values.length*.5)],p95:values[Math.floor(values.length*.95)] });
    }
    entry.lifecycle=[];
    for(let cycle=0;cycle<5;cycle++) {
      await page.getByRole('button',{name:'Unmount workload',exact:true}).click();
      entry.lifecycle.push({cycle,unmounted:await state()});
      await page.getByRole('button',{name:'Mount workload',exact:true}).click();
      await page.waitForTimeout(50);
      await vector('keys-lifecycle/remount', '#page-target', {key:'k',code:'KeyK',ctrlKey:true}, ['search']);
    }
    await page.getByLabel('Strict Mode',{exact:true}).check();
    await page.waitForTimeout(100);
    await vector('keys-lifecycle/strict', '#page-target', {key:'k',code:'KeyK',ctrlKey:true}, ['search']);
    entry.strict=await state();
    await page.getByRole('link',{name:'Fixture second route',exact:true}).click();
    await page.waitForURL('**/second');
    await vector('keys-platform/client-navigation','#page-target',{key:'k',code:'KeyK',ctrlKey:true},['search']);
    await page.screenshot({path:`${captures}/${candidate}-desktop.png`, fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{document.documentElement.lang='ja';document.documentElement.style.fontSize='20px';});
    await page.screenshot({path:`${captures}/${candidate}-narrow-ja-reduced.png`,fullPage:true});
    entry.layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches}));
    // Browser-platform overrides characterize labels, not actual target OS input.
    entry.platforms=[];
    for(const platform of ['MacIntel','Win32','Linux x86_64']) {
      const other=await browser.newContext();
      await other.addInitScript(value=>Object.defineProperty(navigator,'platform',{get:()=>value}),platform);
      const view=await other.newPage();
      const errors=[];view.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text())});
      await view.goto(origin);await view.waitForFunction(()=>window.__fixture&&window.__adapter,undefined,{timeout:60000});
      entry.platforms.push({platform,aria:await view.locator(search).getAttribute('aria-keyshortcuts'),errors});
      await other.close();
    }
    await context.close();
  } catch(error) { entry.setupError=String(error.stack||error); }
  finally {
    await browser?.close();
    try { process.kill(-server.pid,'SIGTERM'); } catch { /* Already stopped. */ }
    await Promise.race([new Promise(done=>server.once('exit',done)),sleep(1500)]);
    try { process.kill(-server.pid,'SIGKILL'); } catch { /* Already stopped. */ }
    writeFileSync(`${captures}/${candidate}-server.log`,Buffer.concat(chunks));
    writeFileSync(`${base}/behavior.json`,JSON.stringify(result,null,2)+'\n');
  }
  console.log(candidate, entry.setupError || `${entry.cases.filter(row=>row.status==='pass').length} passed, ${entry.cases.filter(row=>row.status==='fail').length} failed observation vectors`);
}
result.finishedAt=new Date().toISOString();
writeFileSync(`${base}/behavior.json`,JSON.stringify(result,null,2)+'\n');
if(Object.values(result.candidates).some(entry=>entry.setupError)) process.exitCode=1;
