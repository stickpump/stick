import type { Metadata, Viewport } from "next";
import { SolanaProviders } from "@/components/solana-providers";
import "./styles.css";

export const metadata: Metadata = {
  title: "Stick // Fair Pump.fun Presales",
  description: "Timed Pump.fun presales with creator buy-in, weighted allocation, claim refunds, and clean launch routing."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SolanaProviders>{children}</SolanaProviders>
      </body>
    </html>
  );
}
