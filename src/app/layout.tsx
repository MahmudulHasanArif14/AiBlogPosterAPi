import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Western Cars Content Hub", description: "Central Western Cars travel and taxi information blog." };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="en-GB"><body>{children}</body></html>; }
