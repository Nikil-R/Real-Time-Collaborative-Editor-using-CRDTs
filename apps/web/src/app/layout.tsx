import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CRDT Workspace: real-time collaborative code editor",
  description:
    "Edit code together in real time, even offline. A multi-file workspace built on a from-scratch CRDT (RGA) with live cursors, activity feed and conflict-free merging.",
};

export const viewport: Viewport = { themeColor: "#0a0c11" };

/** Applies the saved theme before first paint so there is no light flash. */
const THEME_SCRIPT = `try{var t=localStorage.getItem('rce:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
