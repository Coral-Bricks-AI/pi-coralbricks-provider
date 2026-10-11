import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-agent-dir.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "tests/__mocks__/pi-coding-agent.ts"),
    },
  },
});
