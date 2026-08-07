/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js references Node's `global`; map it to the
  // browser's globalThis or the login page crashes at import time.
  define: {
    global: "globalThis",
  },
  server: {
    proxy: {
      // Local dev: forward management calls to a locally running gateway.
      "/mgmt": "http://localhost:5080",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true,
  },
});
