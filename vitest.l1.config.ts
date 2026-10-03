import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Used only for the disposable sensitivity check. The source file on disk is never edited.
const mutations: Record<string, { path: string; before: string; after: string }> = {
  midpoint: { path: "/supabase/functions/_shared/liquidity-monthly.ts", before: "const midpointDays = [15, 45", after: "const midpointDays = [16, 45" },
  rate_filter: { path: "/supabase/functions/_shared/liquidity-monthly.ts", before: "rate <= 300", after: "rate <= 10" },
  subordination: { path: "/supabase/functions/_shared/liquidity-monthly.ts", before: "const included = label.includes(\"subordinada\") &&", after: "const included = label.includes(\"junior\") &&" },
  csv_delimiter: { path: "/supabase/functions/_shared/cvm-monthly-csv.ts", before: 'char === ";" && !quoted', after: 'char === "," && !quoted' },
  pdf_header: { path: "/src/lib/liquidityMonthlyExport.ts", before: "RISCO CVPAR  /  RELATÓRIO MENSAL FIDC", after: "RISCO CVPAR  /  CABEÇALHO ALTERADO" },
  pdf_column: { path: "/src/lib/liquidityMonthlyExport.ts", before: 'head: [["Indicador", "Valor", "Qualidade", "Origem / ressalva"]]', after: 'head: [["Indicador", "Valor", "Origem / ressalva", "Qualidade"]]' },
};
const mutation = process.env.L1_MUTATION;
if (mutation && !mutations[mutation]) throw new Error(`Mutação L1 desconhecida: ${mutation}`);

export default defineConfig({
  plugins: [react(), {
    name: "l1-disposable-mutation",
    enforce: "pre",
    transform(code, id) {
      if (!mutation) return null;
      const target = mutations[mutation];
      if (!id.replaceAll("\\", "/").endsWith(target.path)) return null;
      if (code.split(target.before).length !== 2) throw new Error(`Mutação L1 não é única: ${mutation}`);
      return code.replace(target.before, target.after);
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
