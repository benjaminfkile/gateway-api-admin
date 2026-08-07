/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Local dev proxy target for the management plane and hub. Defaults to a
  // locally running gateway; point it at a deployed gateway origin to drive
  // the real fleet from the dev server (server-side proxy, so no CORS).
  const gatewayTarget = env.VITE_MGMT_PROXY_TARGET || "http://localhost:5080";

  return {
    plugins: [react()],
    // amazon-cognito-identity-js references Node's `global`; map it to the
    // browser's globalThis or the login page crashes at import time.
    define: {
      global: "globalThis",
    },
    server: {
      proxy: {
        "/mgmt": { target: gatewayTarget, changeOrigin: true },
        // SignalR: negotiate over HTTP, then upgrade to WebSocket.
        "/hub": { target: gatewayTarget, changeOrigin: true, ws: true },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      globals: true,
    },
  };
});
