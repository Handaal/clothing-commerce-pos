import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    define: {
      "import.meta.env.COMMERCE_API_URL": JSON.stringify(
        environment.COMMERCE_API_URL ?? "http://localhost:3000",
      ),
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(
        environment.VITE_CLERK_PUBLISHABLE_KEY ?? "",
      ),
    },
    build: {
      outDir: "dist",
    },
  };
});
