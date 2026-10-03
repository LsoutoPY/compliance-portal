import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const supabaseUrl = env.VITE_SUPABASE_URL;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5173,
      ...(supabaseUrl
        ? {
            proxy: {
              "/functions/v1": {
                target: supabaseUrl,
                changeOrigin: true,
              },
            },
          }
        : {}),
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react/jsx-dev-runtime",
        "@radix-ui/react-dialog",
        "@radix-ui/react-popover",
        "@radix-ui/react-select",
        "@radix-ui/react-tooltip",
        "@radix-ui/react-dropdown-menu",
        "@radix-ui/react-tabs",
      ],
    },
  };
});
