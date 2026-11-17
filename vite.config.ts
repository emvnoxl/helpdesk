import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/web",
  build: { outDir: "../../dist", emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  // `npm run dev` (hot reload) proxies the API to `npm run dev:server`. "^/api/" is a regex so it doesn't also swallow the source file /api.ts.
  server: { proxy: { "^/api/": "http://127.0.0.1:3000" } },
});
