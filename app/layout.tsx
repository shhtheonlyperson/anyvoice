import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnyVoice",
  description: "Consent-gated VoxCPM2 voice cloning studio.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
