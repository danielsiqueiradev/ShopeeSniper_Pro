import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { 500: "#ee4d2d", 600: "#d53c1e" },  // laranja Shopee
      },
    },
  },
  plugins: [],
};

export default config;
