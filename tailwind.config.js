/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Dark-first surfaces (spec §3)
        ink: {
          bg: "#0B0D10",
          surface: "#111418",
          elevated: "#171B21",
          border: "#242932",
        },
        paper: {
          bg: "#F7F8FA",
          surface: "#FFFFFF",
          border: "#E5E7EB",
        },
        // One restrained primary accent
        accent: {
          DEFAULT: "#7C8CF8",
          dim: "#5A6AE0",
        },
        txt: {
          primary: "#F5F7FA",
          secondary: "#9BA3AF",
          onlight: "#111318",
          onlightsecondary: "#6B7280",
        },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Inter", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
