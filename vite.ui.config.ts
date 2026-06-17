import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: path.resolve(__dirname, "src/ui"),
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@/ui": path.resolve(__dirname, "./src/ui"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist-ui"),
    emptyOutDir: true,
  },
});
