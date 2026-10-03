import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Used only for the disposable sensitivity check. The source file on disk is never edited.
const mutations: Record<string, [string, string]> = {
  midpoint: ["const midpointDays = [15, 45", "const midpointDays = [16, 45"],
  rate_filter: ["rate <= 300", "rate <= 10"],
  subordination: ["const included = label.includes(\"subordinada\") &&", "const included = label.includes(\"junior\") &&"],
};
const mutation = process.env.L1_MUTATION;
if (mutation && !mutations[mutation]) throw new Error(`Mutação L1 desconhecida: ${mutation}`);

export default defineConfig({
  plugins: [react(), {
    name: "l1-disposable-mutation",
    enforce: "pre",
    transform(code, id) {
      if (!mutation || !id.replaceAll("\\", "/").endsWith("/supabase/functions/_shared/liquidity-monthly.ts")) return null;
      const [before, after] = mutations[mutation];
      if (code.split(before).length !== 2) throw new Error(`Mutação L1 não é única: ${mutation}`);
      return code.replace(before, after);
    },
  }],
  resolve: {
    alias: [
      { find: /^npm:jszip@.*$/, replacement: "jszip" },
      { find: /^npm:@supabase\/supabase-js@.*$/, replacement: "@supabase/supabase-js" },
      { find: "@", replacement: path.resolve(__dirname, "src") },
    ],
  },
  test: {
    include: ["tests/l1/**/*.test.ts", "tests/l1/**/*.test.tsx"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 20000,
  },
});
