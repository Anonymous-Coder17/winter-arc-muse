import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { CookieMethodsServer } from "@supabase/ssr";
import { getPublicSupabaseEnvError, getPublicSupabaseEnvOrThrow } from "@/lib/supabase/env";

// Refreshes the Supabase auth session on every request so Server Components
// always see the current user. Redirects unauthenticated users away from
// protected routes, and signed-in users away from /login and /signup.
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isAuthPage = path === "/login" || path === "/signup";

  const envError = getPublicSupabaseEnvError();
  if (envError) {
    return NextResponse.json(
      {
        error:
          "Supabase public environment variables are misconfigured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel, then redeploy.",
        details: envError,
      },
      { status: 500 }
    );
  }

  const { url, anonKey } = getPublicSupabaseEnvOrThrow(
    "Supabase middleware client misconfigured"
  );
  let response = NextResponse.next({ request });

  const cookieMethods: CookieMethodsServer = {
    getAll: () => request.cookies.getAll(),
    setAll: (cookiesToSet) => {
      cookiesToSet.forEach(({ name, value }) =>
        request.cookies.set(name, value)
      );
      response = NextResponse.next({ request });
      cookiesToSet.forEach(({ name, value, options }) =>
        response.cookies.set(name, value, options)
      );
    },
  };

  const supabase = createServerClient(
    url,
    anonKey,
    { cookies: cookieMethods }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No session -> guests can only see auth pages.
  if (!user && !isAuthPage && path !== "/") {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (user && (isAuthPage || path === "/")) {
    return NextResponse.redirect(new URL("/calendar", request.url));
  }
  return response;
}

export const config = {
  // PWA assets (sw.js, manifest, icons) must never hit the auth middleware:
  // the manifest has to be fetchable and the worker installable regardless
  // of session state.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
