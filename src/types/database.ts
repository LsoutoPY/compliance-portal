// Tipos gerados manualmente a partir de supabase/migrations/0001_init.sql.
// Se o schema mudar, atualize este arquivo junto (ou rode `supabase gen types
// typescript` quando o projeto Supabase já existir, e substitua este arquivo
// pelo gerado automaticamente).

export type UserRole = "risco" | "compliance";
export type ImportSourceType = "xlsx" | "pdf" | "xml";
export type ImportStatus = "pending" | "parsed" | "error" | "applied";
export type RegistroTipo = "fundo" | "classe" | "subclasse";
export type RegistroFonte = "cvm_registro_classe" | "cvm_cad_fi" | "manual";
export type IsinFonte = "anbima_data" | "b3" | "manual";
export type LiquidityReportSource = "manual_xlsx" | "cvm_informe_mensal";

export interface Fund {
  id: string;
  short_name: string;
  cnpj: string | null;
  cnpj_fundo_master: string | null;
  administrator: string | null;
  custodian: string | null;
  min_subordination_index: number | null;
  active: boolean;
  created_at: string;
}

export interface FundMaster {
  id: string;
  id_cvm: string;
  cnpj: string | null;
  cnpj_fundo_pai: string | null;
  tipo_registro: RegistroTipo;
  denominacao_social: string | null;
  nome_comercial: string | null;
  tipo_fundo: string | null;
  classe_anbima: string | null;
  situacao: string | null;
  data_registro: string | null;
  data_inicio_atividade: string | null;
  data_cancelamento: string | null;
  administrador_cnpj: string | null;
  administrador_nome: string | null;
  gestor_cnpj: string | null;
  gestor_nome: string | null;
  custodiante_nome: string | null;
  auditor_nome: string | null;
  publico_alvo: string | null;
  condominio: string | null;
  patrimonio_liquido: number | null;
  data_patrimonio_liquido: string | null;
  fonte: RegistroFonte;
  raw_payload: Record<string, unknown> | null;
  last_synced_at: string;
}

export interface FundIsinMap {
  isin: string;
  cnpj: string;
  tipo_cota: string | null;
  fonte: IsinFonte;
  raw_payload: Record<string, unknown> | null;
  updated_at: string;
}

export interface FundMonthlyCvmFiling {
  id: string;
  cnpj: string;
  competencia: string;
  tabela: string;
  payload: Record<string, unknown>[];
  imported_at: string;
}

export interface RegistrySyncLog {
  id: string;
  dataset: string;
  source_url: string | null;
  rows_seen: number | null;
  rows_upserted: number | null;
  status: string;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface Profile {
  id: string;
  full_name: string | null;
  role: UserRole;
  created_at: string;
}

export interface RawImport {
  id: string;
  fund_id: string | null;
  source_type: ImportSourceType;
  reference_month: string | null;
  file_name: string;
  storage_path: string;
  status: ImportStatus;
  parse_error: string | null;
  parsed_payload: Record<string, unknown> | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface LiquidityReport {
  id: string;
  fund_id: string;
  reference_month: string; // YYYY-MM-01
  source: LiquidityReportSource;
  source_import_id: string | null;
  despesa_taxa_administracao: number | null;
  despesa_taxa_custodia: number | null;
  despesa_taxa_gestao: number | null;
  despesa_selic_anbid_cetip_bovespa_anbima: number | null;
  despesa_resgate_amortizacao_iof: number | null;
  despesa_outras: number | null;
  mov_saidas: number | null;
  mov_entradas: number | null;
  mov_captacoes_liquidas: number | null;
  pl: number | null;
  volume_dc_total: number | null;
  volume_dc_vencidos: number | null;
  volume_dc_a_vencer: number | null;
  titulos_publicos_compromissadas: number | null;
  despesas_cpr: number | null;
  valor_pdd: number | null;
  ativos_liquidez_rf_zeragem: number | null;
  saldo_tesouraria: number | null;
  prazo_medio_dc_dias_uteis: number | null;
  prazo_medio_dc_dias_corridos: number | null;
  aquisicoes_no_mes: number | null;
  taxa_cessao_dc: number | null;
  taxa_cessao_du: number | null;
  indice_pdd_sobre_dc: number | null;
  indice_pdd_sobre_pl: number | null;
  valor_vencidos_total: number | null;
  vencidos_pct_dc: number | null;
  vencidos_pct_pl: number | null;
  vencidos_acima_120d: number | null;
  faixa_vencidos_ate_5d: number | null;
  faixa_vencidos_6_30d: number | null;
  faixa_vencidos_31_60d: number | null;
  faixa_vencidos_61_90d: number | null;
  faixa_vencidos_91_120d: number | null;
  faixa_vencidos_acima_120d: number | null;
  volume_total_fidcs: number | null;
  prev_liq_ate_5d: number | null;
  prev_liq_6_30d: number | null;
  prev_liq_31_60d: number | null;
  prev_liq_61_90d: number | null;
  prev_liq_91_120d: number | null;
  prev_liq_121_180d: number | null;
  prev_liq_181_240d: number | null;
  prev_liq_241_300d: number | null;
  prev_liq_301_365d: number | null;
  prev_liq_acima_365d: number | null;
  conc_cedentes_top1: number | null;
  conc_cedentes_top5: number | null;
  conc_cedentes_top10: number | null;
  conc_cedentes_top15: number | null;
  conc_sacados_top1: number | null;
  conc_sacados_top5: number | null;
  conc_sacados_top10: number | null;
  conc_sacados_top15: number | null;
  baixa_deposito_cedente: number | null;
  baixa_recompra: number | null;
  recompra_parcial_sem_adiantamento: number | null;
  outras_liquidacoes: number | null;
  indice_recompra_pct_liquidados: number | null;
  indice_recompra_pct_pl: number | null;
  indice_subordinacao: number | null;
  created_at: string;
  updated_at: string;
}

// ── Ingestão única (migration 0005) ──────────────────────────────────────────

export type IngestSource = "cvm" | "xml";
export type IngestStatus = "running" | "ok" | "error";
export type HoldingSource = "cda" | "xml";

export interface IngestRun {
  id: string;
  dataset: string;
  competencia: string | null;   // YYYY-MM-DD first day or date
  source: IngestSource;
  status: IngestStatus;
  rows_seen: number | null;
  rows_upserted: number | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface FundDailyCvm {
  id: string;
  cnpj: string;
  data: string;                 // YYYY-MM-DD
  pl: number | null;
  valor_cota: number | null;
  captacao_dia: number | null;
  resgate_dia: number | null;
  nr_cotistas: number | null;
  imported_at: string;
}

export interface RawXmlFile {
  id: string;
  fund_id: string | null;
  storage_path: string;
  data_posicao: string | null;
  payload: Record<string, unknown> | null;
  file_name: string | null;
  cnpj: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
}

export interface FundHolding {
  id: string;
  cnpj: string;                 // fundo
  data: string;                 // YYYY-MM-DD
  fonte: HoldingSource;
  linha: number | null;
  isin: string | null;
  ativo: string | null;
  emissor: string | null;
  vencimento: string | null;
  tipo_ativo: string | null;
  valor: number | null;
  pu: number | null;
  quantidade: number | null;
  raw_payload: Record<string, unknown> | null;
}

export interface ComplianceLimit {
  id: string;
  fund_id: string;
  codigo: string;               // e.g. "subordinacao", "conc_sacados_top1"
  descricao: string | null;
  minimo: number | null;
  maximo: number | null;
  unidade: string;              // "pct" | "brl"
  ativo: boolean;
  created_at: string;
}

export interface ComplianceBreach {
  id: string;
  fund_id: string;
  reference_month: string;
  limit_id: string;
  codigo: string;
  valor_realizado: number | null;
  valor_minimo: number | null;
  valor_maximo: number | null;
  status: "ok" | "alerta" | "desenquadrado";
  calculated_at: string;
}

// ── Formato mínimo no padrão do supabase-js `Database` generic. ──────────────
export interface Database {
  public: {
    Tables: {
      funds: { Row: Fund; Insert: Partial<Fund>; Update: Partial<Fund> };
      profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile> };
      raw_imports: { Row: RawImport; Insert: Partial<RawImport>; Update: Partial<RawImport> };
      fund_master: { Row: FundMaster; Insert: Partial<FundMaster>; Update: Partial<FundMaster> };
      fund_isin_map: { Row: FundIsinMap; Insert: Partial<FundIsinMap>; Update: Partial<FundIsinMap> };
      fund_monthly_cvm_filing: {
        Row: FundMonthlyCvmFiling;
        Insert: Partial<FundMonthlyCvmFiling>;
        Update: Partial<FundMonthlyCvmFiling>;
      };
      registry_sync_log: {
        Row: RegistrySyncLog;
        Insert: Partial<RegistrySyncLog>;
        Update: Partial<RegistrySyncLog>;
      };
      liquidity_reports: {
        Row: LiquidityReport;
        Insert: Partial<LiquidityReport>;
        Update: Partial<LiquidityReport>;
      };
      ingest_runs: { Row: IngestRun; Insert: Partial<IngestRun>; Update: Partial<IngestRun> };
      fund_daily_cvm: { Row: FundDailyCvm; Insert: Partial<FundDailyCvm>; Update: Partial<FundDailyCvm> };
      fund_holdings: { Row: FundHolding; Insert: Partial<FundHolding>; Update: Partial<FundHolding> };
      raw_xml_files: { Row: RawXmlFile; Insert: Partial<RawXmlFile>; Update: Partial<RawXmlFile> };
      compliance_limits: { Row: ComplianceLimit; Insert: Partial<ComplianceLimit>; Update: Partial<ComplianceLimit> };
      compliance_breaches: { Row: ComplianceBreach; Insert: Partial<ComplianceBreach>; Update: Partial<ComplianceBreach> };
    };
  };
}
