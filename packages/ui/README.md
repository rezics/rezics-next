# @rezics/ui

Rezics UI: the web app's only component library. It began as a snapshot of all
SharkUI components on Ark UI and is now maintained in this repository, styled
with the Rezics Aura theme. Change components here directly; nothing is synced
from an upstream registry.

```tsx
import { Button } from '@rezics/ui/button';
import { Card } from '@rezics/ui/card';
import { cn } from '@rezics/ui/utils';
```

The web app imports `@rezics/ui/styles.css` once. Color roles, the radius scale,
component alignment and layout conventions are in the
[design system](../../docs/development/design-system.md). The one rule to keep in
mind: the logo red (`--brand`) never colors text; colored text uses the ink blue
`--primary`.

Attribution for SharkUI and Arca UI is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
