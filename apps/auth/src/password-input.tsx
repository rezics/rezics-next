import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@rezics/ui/shadcn/input-group';
import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { useHydrated } from './button';
import { m } from './paraglide/messages.js';

export function PasswordInput(props: Omit<ComponentProps<'input'>, 'type'>) {
  const [visible, setVisible] = useState(false);
  const hydrated = useHydrated();
  return (
    <InputGroup>
      <InputGroupInput {...props} type={visible ? 'text' : 'password'} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-sm"
          aria-label={visible ? m.auth_security_hide_password() : m.auth_security_show_password()}
          aria-pressed={visible}
          aria-controls={props.id}
          disabled={!hydrated || props.disabled}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
