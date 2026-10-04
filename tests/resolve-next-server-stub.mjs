// Test-only resolve hook for tests/google_sync.test.mjs.
//
// Registered at runtime (via `register()` inside the test file, before the
// dynamic import of lib/google/eventSync.ts) because eventSync.ts ->
// lib/google/server.ts imports `next/server`, which is not resolvable under
// plain node. The stub only needs to satisfy the import binding; the tests
// never call NextResponse methods. Every other specifier passes through to
// the next hook in the chain (tests/resolve-hook.mjs, registered globally
// via tests/hooks.mjs).
export async function resolve(specifier, context, next) {
  if (specifier === "next/server") {
    return {
      url: "data:text/javascript,export class NextResponse extends Response {};",
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
