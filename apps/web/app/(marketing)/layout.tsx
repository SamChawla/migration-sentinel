import type { ReactNode } from "react";
import { DM_Sans, Instrument_Serif } from "next/font/google";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import "@/styles/editorial.css";

// Editorial-only families: loaded here (not in the root layout) so their assets
// are only preloaded on marketing routes. The variables are scoped to the
// .editorial wrapper, where editorial.css reads them via --serif / --sans.
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans", display: "swap" });
const instrumentSerif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument-serif", display: "swap" });

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`editorial ${dmSans.variable} ${instrumentSerif.variable}`}>
      <MarketingNav />
      {children}
      <MarketingFooter />
    </div>
  );
}
