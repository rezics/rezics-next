/** A configuration value is missing or malformed. The message names the variable only. */
export class ConfigError extends Error {
  constructor(variable: string) {
    super(`Invalid or missing ${variable}`);
    this.name = 'ConfigError';
  }
}
