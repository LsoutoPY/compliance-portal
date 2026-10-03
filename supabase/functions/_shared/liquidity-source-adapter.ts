import type { CvmRow, CvmTables, PositionEvidence } from "./liquidity-monthly.ts";

export interface MonthlyFilingRecord {
  tabela: string;
  payload: unknown;
  source_origin?: string | null;
  source_sha256?: string | null;
  source_storage_path?: string | null;
  imported_at?: string | null;
  registry_sync_log_id?: string | null;
}

export interface PositionRecord {
  summary: unknown;
  file_sha256?: string | null;
  imported_at?: string | null;
  imported_by?: string | null;
  file_name?: string | null;
}

export interface InputProvenance {
  source: "manual";
  file: string | null;
  sha256: string | null;
  importedAt: string | null;
  userId: string | null;
  auditLogId?: string | null;
}

export interface AdaptedMonthlyInputs {
  tables: CvmTables;
  position: PositionEvidence | null;
  provenance: { informeMensal: InputProvenance[]; carteiraDiaria: InputProvenance | null };
}

// Consome os fatos já importados pelo fluxo atual. Não lê banco, rede ou UI.
// Fonte "manual" inclui o download CVM acionado pelo operador no portal.
export const ManualUploadAdapter = {
  fromRecords(filings: MonthlyFilingRecord[], snapshot: PositionRecord | null): AdaptedMonthlyInputs {
    const tables: CvmTables = {};
    for (const filing of filings) {
      tables[filing.tabela] = Array.isArray(filing.payload) ? filing.payload as CvmRow[] : [];
    }
    return {
      tables,
      position: snapshot?.summary as PositionEvidence | null,
      provenance: {
        informeMensal: filings.map((filing) => ({
          source: "manual",
          file: filing.source_origin ?? filing.source_storage_path ?? null,
          sha256: filing.source_sha256 ?? null,
          importedAt: filing.imported_at ?? null,
          userId: null,
          auditLogId: filing.registry_sync_log_id ?? null,
        })),
        carteiraDiaria: snapshot ? {
          source: "manual",
          file: snapshot.file_name ?? null,
          sha256: snapshot.file_sha256 ?? null,
          importedAt: snapshot.imported_at ?? null,
          userId: snapshot.imported_by ?? null,
        } : null,
      },
    };
  },
};
