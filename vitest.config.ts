import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 30000,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/lib/testBridge.ts",
      ],
      thresholds: {
        "src/components/*.tsx": {
          lines: 95,
          statements: 95,
          branches: 80,
        },
        "src/lib/*.ts": {
          lines: 85,
          branches: 78,
        },
      },
    },
  },
});
