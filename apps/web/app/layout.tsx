import "./globals.css";
import type { ReactNode } from "react";
import { Chakra_Petch, IBM_Plex_Mono } from "next/font/google";

// Only the console fonts load app-wide. The editorial (DM Sans + Instrument
// Serif) families are marketing-only and are loaded in the marketing layout so
// console routes don't preload font assets they never render.
const chakra = Chakra_Petch({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-chakra", display: "swap" });
const ibm = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-ibm", display: "swap" });

export const metadata = {
  title: "Migration Sentinel",
  description: "The AI migration agent that pauses for a human before anything irreversible.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${chakra.variable} ${ibm.variable}`}>
      <head />
      <body>
        <div className="grid-floor" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
