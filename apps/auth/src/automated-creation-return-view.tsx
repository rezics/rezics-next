import { useLayoutEffect, useRef } from 'react';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { AutomatedCreationReturnHistory, AutomatedCreationReturnFact } from './automated-creation-return';

const copy: Record<AutomatedCreationReturnFact, () => string> = {
  unknown: () => m.auth_automated_history_unknown(),
  interrupted: () => m.auth_automated_history_interrupted(),
  acknowledged: () => m.auth_automated_history_acknowledged(),
};

export function AutomatedCreationReturnView({
  history,
  dismissed,
  focusRequest,
  onDismiss,
}: {
  history: AutomatedCreationReturnHistory;
  dismissed: boolean;
  focusRequest: number;
  onDismiss: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const dismissedMessage = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    if (history.length) heading.current?.focus();
    else if (dismissed) dismissedMessage.current?.focus();
  }, [dismissed, focusRequest, history.length]);
  if (!history.length && !dismissed) return null;
  return (
    <section className="space-y-3" aria-labelledby="automated-return-heading">
      <h2
        id="automated-return-heading"
        ref={heading}
        tabIndex={-1}
        className="focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      >
        {m.auth_automated_history_heading()}
      </h2>
      {history.length ? (
        <>
          <ul className="space-y-2">
            {history.map((fact) => (
              <li key={fact}>
                <p role="status" aria-live="polite">
                  {copy[fact]()}
                </p>
              </li>
            ))}
          </ul>
          <Button type="button" onClick={onDismiss}>
            {m.auth_automated_history_dismiss()}
          </Button>
        </>
      ) : (
        <p
          ref={dismissedMessage}
          id="automated-return-dismissed"
          role="status"
          tabIndex={-1}
          className="focus:outline-2 focus:outline-offset-2 focus:outline-ring"
        >
          {m.auth_automated_history_dismissed()}
        </p>
      )}
    </section>
  );
}
