import type { Config } from "tailwindcss";

const config: Config = {
  // v4 expects ["class", ".dark"] for selector mode
  darkMode: ["class", ".dark"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    container: { center: true, padding: "1rem" },
    extend: {
      colors: {
        bg: "hsl(var(--bg))",
        surface: "hsl(var(--surface))",
        card: "hsl(var(--card))",
        popover: "hsl(var(--popover))",
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        foreground: "hsl(var(--foreground))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))"
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))"
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))"
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))"
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))"
        }
      },
      borderRadius: {
        lg: "0.6rem",
        md: "0.5rem",
        sm: "0.375rem"
      },
      boxShadow: { card: "0 8px 24px rgba(0,0,0,0.12)" },
      keyframes: { skeleton: { "0%,100%": { opacity: 0.55 }, "50%": { opacity: 1 } } },
      animation: { skeleton: "skeleton 1.2s ease-in-out infinite" },
      fontFamily: {
        sans: ['"Mr Eaves"', "Arial", "ui-sans-serif", "system-ui"],
        serif: ['"Mrs Eaves"', '"Times New Roman"', "ui-serif", "Georgia"]
      }
    }
  },
  plugins: [require("@tailwindcss/typography")]
};

export default config;
