import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lead Dedupe",
  description: "Upload a CSV, find already-contacted emails, download only new leads.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
