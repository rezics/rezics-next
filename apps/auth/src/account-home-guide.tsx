import { m } from './paraglide/messages.js';
import './account-home-guide.css';

/** Public review navigation. Private identity and native command advice stay with their owners. */
export function AccountHomeGuide() {
  return (
    <div className="auth-home-guide">
      <section className="auth-home-settings" aria-labelledby="auth-home-settings-heading">
        <h2 id="auth-home-settings-heading">{m.auth_home_settings_heading()}</h2>
        <p>{m.auth_home_settings_description()}</p>
        <nav aria-label={m.auth_home_navigation_label()}>
          <a className="auth-home-link" href="/account/rename">
            <span>
              <strong>{m.auth_home_rename()}</strong>
              <small>{m.auth_home_rename_description()}</small>
            </span>
          </a>
          <a className="auth-home-link auth-home-delete" href="/account/delete">
            <span>
              <strong>{m.auth_home_delete()}</strong>
              <small>{m.auth_home_delete_description()}</small>
            </span>
          </a>
        </nav>
      </section>

      <section className="auth-home-settings" aria-labelledby="auth-home-security-heading">
        <h2 id="auth-home-security-heading">{m.auth_home_security_group()}</h2>
        <nav aria-labelledby="auth-home-security-heading">
          <a className="auth-home-link" href="/security">
            <span>
              <strong>{m.auth_home_security()}</strong>
              <small>{m.auth_home_security_description()}</small>
            </span>
          </a>
        </nav>
      </section>

      <section className="auth-home-settings" aria-labelledby="auth-home-accounts-heading">
        <h2 id="auth-home-accounts-heading">{m.auth_home_accounts_group()}</h2>
        <p>{m.auth_home_accounts_description()}</p>
        <nav aria-labelledby="auth-home-accounts-heading">
          <a className="auth-home-link" href="/organizations/new">
            <span>
              <strong>{m.auth_home_organization()}</strong>
              <small>{m.auth_home_organization_description()}</small>
            </span>
          </a>
          <a className="auth-home-link" href="/automated/new">
            <span>
              <strong>{m.auth_home_automated()}</strong>
              <small>{m.auth_home_automated_description()}</small>
            </span>
          </a>
        </nav>
      </section>

      <section className="auth-home-settings" aria-labelledby="auth-home-selection-heading">
        <h2 id="auth-home-selection-heading">{m.auth_home_selection_heading()}</h2>
        <p>{m.auth_home_selection_description()}</p>
        <div className="auth-home-selection">
          <section aria-labelledby="auth-home-members-heading">
            <h3 id="auth-home-members-heading">{m.auth_home_members()}</h3>
            <p>{m.auth_home_members_description()}</p>
            <a href="/security">{m.auth_home_members_exit()}</a>
          </section>
          <section aria-labelledby="auth-home-org-delete-heading">
            <h3 id="auth-home-org-delete-heading">{m.auth_home_organization_delete()}</h3>
            <p>{m.auth_home_organization_delete_description()}</p>
            <a href="/security">{m.auth_home_organization_delete_exit()}</a>
          </section>
          <section aria-labelledby="auth-home-transfer-heading">
            <h3 id="auth-home-transfer-heading">{m.auth_home_transfer()}</h3>
            <p>{m.auth_home_transfer_description()}</p>
            <a href="/security">{m.auth_home_transfer_exit()}</a>
          </section>
          <section aria-labelledby="auth-home-opening-heading">
            <h3 id="auth-home-opening-heading">{m.auth_home_opening()}</h3>
            <p>{m.auth_home_opening_description()}</p>
            <a href="/security">{m.auth_home_opening_exit()}</a>
          </section>
        </div>
      </section>
    </div>
  );
}
