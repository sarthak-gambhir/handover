import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.CLIENT_PORT ?? 5173);
  // Where to proxy /api (REST + WebSocket) during dev.
  const apiTarget =
    env.API_TARGET ?? `http://localhost:${env.SERVER_PORT ?? 3000}`;

  return {
    plugins: [react()],
    server: {
      port,
      // host: true exposes the dev server on the local network.
      host: env.CLIENT_HOST ?? "localhost",
      strictPort: true,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
