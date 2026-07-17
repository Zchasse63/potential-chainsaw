import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the pinned, PII-redacted Glofox samples (docs/glofox/samples/). */
const SAMPLES_DIR = fileURLToPath(new URL("../../../docs/glofox/samples/", import.meta.url));

export function loadSample(fileName: string): unknown {
  return JSON.parse(readFileSync(join(SAMPLES_DIR, fileName), "utf8")) as unknown;
}
