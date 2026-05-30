import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@pump-fun/agent-payments-sdk": fileURLToPath(new URL("./src/test/agent-payments-sdk.mock.ts", import.meta.url))
    }
  }
});
