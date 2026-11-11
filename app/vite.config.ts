import { defineConfig } from "vite";

// client/ sits next to app/ and is imported as TypeScript source.
export default defineConfig({
  server: { port: 5180, fs: { allow: [".."] } },
  build: { target: "es2022" },
});
