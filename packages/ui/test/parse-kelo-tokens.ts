/**
 * Shared parser for the Kelo token files (packages/ui/test). Extracts every
 * `--kelo-*: value;` declaration from a CSS string into a name → value map
 * (name without the `--kelo-` prefix). Comments are stripped first so
 * commented-out or prose mentions are never parsed; first occurrence wins, so
 * the prefers-reduced-motion override of a variable never shadows the base
 * :root declaration.
 */
export function parseKeloTokens(css: string): Map<string, string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, string>();
  const declaration = /--kelo-([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(stripped)) !== null) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    if (!tokens.has(name)) tokens.set(name, value.trim());
  }
  return tokens;
}
