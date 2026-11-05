import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { m } from '../paraglide/messages.js';
import { AppearanceControls } from '../shell/appearance-controls';

export function DisplayPreferences() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-display-heading">{m.settings_display_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_display_text()}</CardDescription>
      </CardHeader>
      <CardContent>
        <AppearanceControls />
      </CardContent>
    </Card>
  );
}
