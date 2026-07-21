import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    api: false,
    environment: "node",
    pool: "forks",
    include: ["electron/**/*.test.ts"],
    exclude: ["dist/**", "dist-electron/**", "node_modules/**"]
  },
  server: {
    host: "127.0.0.1",
    hmr: false
  }
});
