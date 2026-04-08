import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#151311",
        copper: "#B87333",
        sienna: "#C9553D",
        slate: "#5A6B7A",
        surface: "#1A1917",
        "surface-light": "#242220",
        border: "#333330",
      },
      fontFamily: {
        serif: ['"Inria Serif"', "serif"],
        sans: ['"Inria Sans"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      borderRadius: {
        DEFAULT: "0px",
      },
    },
  },
  plugins: [],
} satisfies Config;
