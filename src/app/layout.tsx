import type { Metadata } from "next";
import "./globals.css";
import { siteUrl } from "@/lib/posts-repository";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "Western Cars Content Hub",
    template: "%s | Western Cars Content Hub",
  },
  description:
    "Central Western Cars travel and taxi information blog, with a read-only content API for location websites.",
  openGraph: {
    siteName: "Western Cars Content Hub",
    locale: "en_GB",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
