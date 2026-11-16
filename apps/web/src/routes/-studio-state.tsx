import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

export function StudioMessage({ message }: { message: string }) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-8">
      <h1>{m.studio_title({}, { locale: getLocale() })}</h1>
      <p role="alert">{message}</p>
    </div>
  );
}

export function StudioPreparing() {
  return <p role="status">{m.studio_account_preparing({}, { locale: getLocale() })}</p>;
}
