import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.CLIENT_PORT ?? 5173);
  // Where to proxy /api (REST + WebSocket) during dev.
  const apiTarget =
    env.API_TARGET ?? `http://localhost:${env.SERVER_PORT ?? 3000}`;

  return {
    // basicSsl provisions a self-signed cert and serves the dev server over
    // HTTPS, so a LAN IP becomes a secure context (matching localhost/prod).
    // That keeps the auth cookie working and re-enables WebCrypto (E2EE) on
    // the LAN. Only the browser<->Vite leg is TLS; the proxy target below
    // stays plain HTTP (server-to-server).
    plugins: [react(), basicSsl()],
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
