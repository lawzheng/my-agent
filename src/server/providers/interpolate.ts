import { execFileSync } from "node:child_process";

const commandCache = new Map<string, string>();

const DOLLAR_PLACEHOLDER = "\u0000PI_DOLLAR\u0000";
const BANG_PLACEHOLDER = "\u0000PI_BANG\u0000";

/**
 * Resolve a configured secret value. Supported forms:
 *   - `!command`      run the command once and cache its stdout
 *   - `$NAME`         read an environment variable
 *   - `${NAME}`       same, braced
 *   - `$$` / `$!`     literal `$` / literal leading `!`
 *   - anything else   used as-is
 *
 * A missing environment variable resolves to an empty string so callers can treat
 * "no credential" uniformly.
 */
export function resolveSecret(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("!")) return resolveCommand(value.slice(1));
  return interpolate(value);
}

export function interpolate(value: string): string {
  return value
    .replace(/\$\$/g, () => DOLLAR_PLACEHOLDER)
    .replace(/\$!/g, () => BANG_PLACEHOLDER)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
      return process.env[braced ?? plain] ?? "";
    })
    .replaceAll(DOLLAR_PLACEHOLDER, () => "$")
    .replaceAll(BANG_PLACEHOLDER, () => "!");
}

export function resolveCommand(command: string): string {
  const cached = commandCache.get(command);
  if (cached !== undefined) return cached;

  const output = execFileSync(command, {
    shell: true,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

  commandCache.set(command, output);
  return output;
}

/** Test helper: drop cached command output so a test can re-run a command. */
export function clearSecretCache(): void {
  commandCache.clear();
}
