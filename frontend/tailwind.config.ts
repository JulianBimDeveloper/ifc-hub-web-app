import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        border: "var(--border)",
        "border-bright": "var(--border-bright)",
        cyan: "var(--cyan)",
        magenta: "var(--magenta)",
        green: "var(--green)",
        yellow: "var(--yellow)",
        red: "var(--red)",
        text: "var(--text)",
        "text-muted": "var(--text-muted)",
        "text-bright": "var(--text-bright)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "var(--font-plex-sans)", "sans-serif"],
        heading: ["var(--font-inter)", "sans-serif"],
        mono: ["var(--font-plex-mono)", "Courier New", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
