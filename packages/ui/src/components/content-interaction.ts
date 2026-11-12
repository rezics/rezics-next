/** Raise individual controls, preserving positioned cover actions and leaving plain content in the primary hit area. */
export const independentControlsClassName = [
  '[&_:is(a,button,summary,label,input,select,textarea,[tabindex],[contenteditable=true]):not(.absolute,.fixed)]:relative',
  '[&_:is(a,button,summary,label,input,select,textarea,[tabindex],[contenteditable=true])]:z-20',
  '[&_.absolute:is(a,button,summary,label,input,select,textarea,[tabindex],[contenteditable=true])]:absolute',
  '[&_.fixed:is(a,button,summary,label,input,select,textarea,[tabindex],[contenteditable=true])]:fixed',
  '[&_:is(a,button,summary,input,select,textarea,[tabindex],[contenteditable=true]):focus-visible]:outline-2',
  '[&_:is(a,button,summary,input,select,textarea,[tabindex],[contenteditable=true]):focus-visible]:outline-offset-2',
  '[&_:is(a,button,summary,input,select,textarea,[tabindex],[contenteditable=true]):focus-visible]:outline-ring',
  '[&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:items-center',
  '[&_button]:min-h-11 [&_button]:min-w-11',
  '[&_label]:inline-block [&_:is(summary,label)]:min-h-11 [&_:is(summary,label)]:min-w-11',
  '[&_:is(input:not([type=checkbox],[type=radio],[type=hidden]),select,textarea)]:min-h-11 [&_:is(input:not([type=checkbox],[type=radio],[type=hidden]),select,textarea)]:min-w-11',
  '[&_:is(a,button,summary,label,input,select,textarea)]:max-w-full',
  '[&_:is(a,button,summary,label,textarea)]:whitespace-normal',
  '[&_:is(a,button,summary,label,textarea)]:wrap-anywhere',
].join(' ');

/** A selection gesture must not intercept a nested native or composite control's activation. */
export const independentControlSelector =
  'a, button, input, select, textarea, summary, label, [tabindex], [contenteditable="true"], [role="button"], [role="checkbox"], [role="menuitem"]';
