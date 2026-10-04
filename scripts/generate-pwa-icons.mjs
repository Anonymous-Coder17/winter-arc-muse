// Generates the PWA icon PNGs from the base64 data in pwa-icons.base64.json.
// The GitHub connector used for syncing cannot transport binary files, so the
// icons live in the repo as text and are materialized into public/icons/ on
// `npm install` (postinstall) and before tests. Vercel runs npm install before
// building, so deployed builds always have the real PNGs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "scripts", "pwa-icons.base64.json"), "utf8"));
const outDir = join(root, "public", "icons");
mkdirSync(outDir, { recursive: true });

for (const [name, b64] of Object.entries(data)) {
  writeFileSync(join(outDir, name), Buffer.from(b64, "base64"));
  console.log(`generated public/icons/${name}`);
}
