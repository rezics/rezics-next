# Third-party notices

## ProseMirror Transform

The native sequence evaluator in `src/components/editor-native-mapping.ts` adapts the leaf/recovery semantics of
`prosemirror-transform` **1.12.4**, `src/map.ts` (`Mapping._map`), from the exact installed dependency source at
`node_modules/.bun/prosemirror-transform@1.12.4/node_modules/prosemirror-transform/src/map.ts`.
The summary tree and owned-command cache avoid evaluating provably untouched subsequences; native StepMaps,
mirrors and history Items are retained. The adaptation uses the pinned runtime's internal MapResult fields.

```text
Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

The source adapted from Reactjs Tiptap Editor keeps its exact revision, source-file mapping, adaptation notes
and full MIT notice in [the upstream directory](src/components/editor-upstream/reactjs-tiptap-editor/README.md)
and [its license](src/components/editor-upstream/reactjs-tiptap-editor/LICENSE).

The shared prose styles and moved components retain the SharkUI notice formerly supplied by the UI package.
[UI notices](../ui/THIRD_PARTY_NOTICES.md) also cover the generic primitives imported by this package.

## SharkUI

The moved components and `src/prose.css` derive from SharkUI commit
`d43c3c2c7a5e683d46930c2ce8eb22eca2f8a0a0`.

```text
MIT License

Copyright (c) 2026 Vinicius Vicentini

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
