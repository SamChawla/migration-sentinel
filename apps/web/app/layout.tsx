import "./globals.css";
import type { ReactNode } from "react";
import { Chakra_Petch, IBM_Plex_Mono, DM_Sans, Instrument_Serif } from "next/font/google";

const chakra = Chakra_Petch({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-chakra", display: "swap" });
const ibm = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-ibm", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans", display: "swap" });
const instrumentSerif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument-serif", display: "swap" });

export const metadata = {
  title: "Migration Sentinel",
  description: "The AI migration agent that pauses for a human before anything irreversible.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${chakra.variable} ${ibm.variable} ${dmSans.variable} ${instrumentSerif.variable}`}>
      <head />
      <body>
        <div className="grid-floor" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
