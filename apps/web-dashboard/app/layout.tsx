import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShopeeSniper Pro — Dashboard",
  description: "Inteligência de mercado Shopee BR",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
