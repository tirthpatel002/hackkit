export class HarnessError extends Error {
  constructor(
    message: string,
    readonly opts: { cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
  }
}

/** Config, YAML, schema validation, missing export or CLI option errors. Never retried. */
export class ConfigError extends HarnessError {}
