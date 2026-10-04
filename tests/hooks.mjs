// Registered via `node --test --import ./tests/hooks.mjs tests/`.
// Resolves extensionless relative imports (e.g. "./dates") to their .ts
// files so tests can import the real TypeScript lib sources. Node's
// built-in type stripping handles the rest (erasable syntax only).
import { register } from "node:module";

register("./resolve-hook.mjs", import.meta.url);
