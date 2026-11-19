import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom", "clsx", "zustand", "immer"],
    alias: {
      "@deepseek-ai/dsh-client-ui-primitives": fileURLToPath(new URL("../../vendor/deepseek-harness/source/packages/client/ui-primitives/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    // Browser storage belongs to jsdom, including on Node versions with Web Storage enabled.
    execArgv: ["--no-experimental-webstorage"],
    setupFiles: ["./vitest.setup.ts"],
    clearMocks: true,
  },
})
