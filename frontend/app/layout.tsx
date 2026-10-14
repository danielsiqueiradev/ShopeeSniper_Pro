import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShopeeProfit AI",
  description: "Inteligência de mercado e margem líquida para sellers Shopee",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="bg-slate-950 text-slate-100 antialiased">
        <nav className="border-b border-slate-800 px-6 py-3 flex items-center gap-6">
          <span className="font-bold text-brand-500 text-lg">ShopeeProfit AI</span>
          <a href="/" className="text-sm text-slate-400 hover:text-white">Radar</a>
          <a href="/niches" className="text-sm text-slate-400 hover:text-white">Nichos</a>
          <a href="/simulations" className="text-sm text-slate-400 hover:text-white">Calculadora</a>
        </nav>
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
