import { Window } from 'happy-dom';

/** Local real EditorView dispatch; Chromium journeys separately establish layout and native input behavior. */
export async function editorDOM<T>(operation: () => Promise<T> | T): Promise<T> {
  const window = new Window();
  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    Text: window.Text,
    MutationObserver: window.MutationObserver,
    DOMParser: window.DOMParser,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    return await operation();
  } finally {
    await window.happyDOM.abort();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
