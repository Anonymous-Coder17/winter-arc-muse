import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export async function resolve(specifier, context, next) {
  // Test-only stub: the real `server-only` package throws on import outside a
  // React Server Component context, which would make server-only modules such
  // as lib/google/tokenVault.ts (whose first line is `import "server-only"`)
  // unimportable under plain node. Map the bare specifier to an empty module
  // so tests can exercise the real code beneath the marker import.
  if (specifier === "server-only") {
    return {
      url: "data:text/javascript,export default {};",
      shortCircuit: true,
    };
  }
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".")) {
      const parentPath = fileURLToPath(context.parentURL);
      const candidate = path.resolve(path.dirname(parentPath), specifier);
      if (!path.extname(candidate) && existsSync(candidate + ".ts")) {
        return {
          url: pathToFileURL(candidate + ".ts").href,
          shortCircuit: true,
        };
      }
    }
    throw err;
  }
}
