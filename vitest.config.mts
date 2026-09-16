import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // `@nexusmods/vortex-api` ships type declarations only; at runtime the
      // host application provides it. Tests use an in-memory stand-in.
      "@nexusmods/vortex-api": `${root}game-warhammer40kdarktide/src/__tests__/mocks/vortex-api.ts`,
    },
  },
  test: {
    environment: "node",
    include: ["game-warhammer40kdarktide/src/**/*.test.ts"],
  },
});
