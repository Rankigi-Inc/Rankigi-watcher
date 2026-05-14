import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/__stubs__/obsidian.ts"),
    },
  },
});
