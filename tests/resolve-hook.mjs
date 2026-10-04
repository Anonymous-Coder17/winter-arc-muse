import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export async function resolve(specifier, context, next) {
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
