import { describe, expect, it } from "vitest";
import { ManualUploadAdapter } from "../../supabase/functions/_shared/liquidity-source-adapter.ts";

describe("L2 · adaptador da fonte atual", () => {
  it("preserva a seleção de payloads, incluindo duplicidade e ausência de posição", () => {
    const filings = [
      { tabela: "tab_I", payload: [{ value: "1" }], source_origin: "upload:synthetic.zip", source_sha256: "hash-1", imported_at: "2026-02-01T00:00:00Z", registry_sync_log_id: "log-1" },
      { tabela: "tab_I", payload: [{ value: "2" }], source_origin: "upload:synthetic.zip", source_sha256: "hash-1", imported_at: "2026-02-01T00:00:00Z", registry_sync_log_id: "log-1" },
      { tabela: "tab_IV", payload: null, source_origin: "upload:synthetic.zip" },
    ];
    const adapted = ManualUploadAdapter.fromRecords(filings, null);
    expect(adapted.tables).toEqual({ tab_I: [{ value: "2" }], tab_IV: [] });
    expect(adapted.position).toBeUndefined(); // comportamento legado no hash da execução
    expect(adapted.provenance.informeMensal[0]).toEqual({
      source: "manual", file: "upload:synthetic.zip", sha256: "hash-1",
      importedAt: "2026-02-01T00:00:00Z", userId: null, auditLogId: "log-1",
    });
  });

  it("preserva o resumo CPR e a trilha da Carteira Diária", () => {
    const summary = { cnpj: "00000000000001", expenses: { administration: -10 } };
    const adapted = ManualUploadAdapter.fromRecords([], {
      summary, file_name: "synthetic_carteira.csv", file_sha256: "hash-2",
      imported_at: "2026-02-02T10:00:00Z", imported_by: "synthetic-user",
    });
    expect(adapted.position).toBe(summary);
    expect(adapted.provenance.carteiraDiaria).toEqual({
      source: "manual", file: "synthetic_carteira.csv", sha256: "hash-2",
      importedAt: "2026-02-02T10:00:00Z", userId: "synthetic-user",
    });
  });
});
