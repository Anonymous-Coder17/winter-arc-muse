import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/profile";
import { AppShell } from "@/components/shell";

// Protected area: every page under here requires a session.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth
    .getUser()
    .catch(() => ({ data: { user: null } }));

  if (!user) redirect("/login");
  await ensureProfile(supabase, user.id);

  return <AppShell email={user.email ?? ""}>{children}</AppShell>;
}
