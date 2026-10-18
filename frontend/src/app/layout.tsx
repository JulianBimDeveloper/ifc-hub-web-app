"use client";

import "./globals.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Inter, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";

// Inter drives headings/nav/buttons (the bold editorial sans look); IBM Plex
// Sans stays for dense body/table text; IBM Plex Mono for data/mono spans.
// Loaded via next/font (self-hosted at build time) instead of the old
// render-blocking Google Fonts @import — no more flash of unstyled text.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-inter",
  display: "swap",
});
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-plex-sans",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

// Anti-flash: apply theme class before first paint
const themeInitScript = `
(function() {
  try {
    var pref = localStorage.getItem('fractal-theme') || 'system';
    var cls;
    if (pref === 'system') {
      cls = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } else {
      cls = pref;
    }
    document.documentElement.classList.add(cls);
  } catch(e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  }));

  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <title>Fractal IFC</title>
        <meta name="description" content="Fractal IFC — BIM Intelligence Suite" />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`${inter.variable} ${plexSans.variable} ${plexMono.variable}`}>
        <QueryClientProvider client={qc}>
          {children}
        </QueryClientProvider>
      </body>
    </html>
  );
}
