import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme";

export const metadata: Metadata = {
  title: "Winter Arc — 30-Day Transformation",
  description:
    "A personal command center for your 30-day transformation: plan, execute, record, review.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Avoids a theme flash: applies stored (or default dark) appearance before paint.
const themeInitScript = `(function(){try{var a=localStorage.getItem('winter-arc-appearance')||'dark';var r=a==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):a;document.documentElement.classList.toggle('dark',r==='dark');document.documentElement.style.colorScheme=r;}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
