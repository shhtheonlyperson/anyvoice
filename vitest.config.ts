import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 15_000,
    // Playwright owns e2e/ (see playwright.config.ts); keep vitest off it.
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**"],
    coverage: {
      reporter: ["text", "text-summary"],
      include: ["lib/**", "app/**", "components/**"],
      exclude: [
        "**/*.d.ts",
        "**/.next/**",
        "**/node_modules/**",
        "**/tests/**",
        "**/*.config.*",
      ],
    },
  },
});
