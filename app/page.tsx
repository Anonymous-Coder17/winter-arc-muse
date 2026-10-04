import { redirect } from "next/navigation";

// Entry point. Middleware routes signed-in users to /calendar and guests
// to /login; this is the final fallback.
export default function Home() {
  redirect("/calendar");
}
