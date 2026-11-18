/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#0A0F18",
        pitch: "#0D1117",
        "slate-dark": "#111827",
        ink: "#1A2030",
        slate: "#1A2535",
        steel: "#4A5A6A",
        fog: "#8898A8",
        mist: "#E8EEF6",
        frost: "#F2F6FB",
        ember: "#FF5500",
        burnt: "#D94400",
        cobalt: "#2255AA",
        plum: "#8833AA",
        pine: "#1E6B35",
        signal: "#CC0000",
      },
      fontFamily: {
        sans: ['"DM Sans"', "sans-serif"],
        mono: ['"Fira Code"', "monospace"],
      },
      borderRadius: {
        panel: "10px",
      },
    },
  },
  plugins: [],
};
