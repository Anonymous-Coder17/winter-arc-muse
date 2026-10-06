# winter-arc-muse

## Supabase + Vercel deployment setup

1. Create a Supabase project.
2. Apply every migration in `/supabase/migrations` in order (`0001` through the latest file).
3. In Vercel, set these environment variables for each environment you deploy (Production/Preview/Development):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Only if you use **Delete account** (`POST /api/account/delete`), also set:
   - `SUPABASE_SERVICE_ROLE_KEY`
   - Keep this server-only (never `NEXT_PUBLIC_*`).
5. After adding or changing any Supabase environment variable in Vercel, redeploy so Next.js runtime and middleware pick up the new values.

### Supabase Auth URL configuration

In Supabase Dashboard → Authentication → URL Configuration:

- Set **Site URL** to your deployed Vercel app URL (for example `https://your-app.vercel.app`).
- Add redirect URLs used by your app (for example auth callback URLs under the same Vercel domain, including preview URLs if you sign in there).
- Ensure URL values exactly match protocol/host used in Vercel.

If `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` is missing/invalid, the app now fails fast with a clear runtime error instead of silently redirecting to `/login`.