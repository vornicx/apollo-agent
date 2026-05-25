import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || "";
  const supabasePublishableKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || "";
  const supabaseProjectId = env.VITE_SUPABASE_PROJECT_ID || "";

  return {
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
      "import.meta.env.VITE_SUPABASE_PROJECT_ID": JSON.stringify(supabaseProjectId),
    },
    plugins: [
      tanstackStart({
        server: { entry: "server" },
      }),
      react(),
      tailwindcss(),
      tsConfigPaths(),
      cloudflare(),
      {
        name: "apollo-tanstack-head-scripts-fallback",
        enforce: "pre",
        resolveId(id) {
          if (id === "tanstack-start-injected-head-scripts:v") {
            return "\0tanstack-start-injected-head-scripts:v";
          }
        },
        load(id) {
          if (id === "\0tanstack-start-injected-head-scripts:v") {
            return "export const injectedHeadScripts = undefined;";
          }
        },
      },
    ],
    resolve: {
      dedupe: [
        "react",
        "react-dom",
        "@tanstack/react-router",
        "@tanstack/react-start",
        "@tanstack/router-core",
        "@tanstack/react-query",
      ],
    },
  };
});
