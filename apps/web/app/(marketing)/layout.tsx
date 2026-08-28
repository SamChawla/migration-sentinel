import type { ReactNode } from "react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import "@/styles/editorial.css";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="editorial">
      <MarketingNav />
      {children}
      <MarketingFooter />
    </div>
  );
}
