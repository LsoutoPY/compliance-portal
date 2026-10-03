export type TipoAtivo = "IF" | "CORPORATIVO" | "ESTRUTURADO" | "COTA_FUNDO";
export type TipoAnalise = "AQUISICAO" | "MONITORAMENTO";
export type Recomendacao = "COMPRAR" | "MANTER" | "VENDER" | "APROVAR" | "NAO_APROVAR";
export type DecisaoComite = "APROVADO" | "NAO_APROVADO" | "VENDA_AUTORIZADA" | "MONITORAR";
export type StatusAtivo =
  | "ATIVO"
  | "EM_ANALISE"
  | "SUSPENSO"
  | "ENCERRADO"
  | "NAO_APLICAVEL";
export type StatusAgenda = "PENDENTE" | "EM_ANDAMENTO" | "CONCLUIDO";
export type TipoDesenquadramento = "PRECO" | "CONCENTRACAO" | "LIMITE_POLITICA" | "SUITABILITY";
export type StatusDesenquadramento = "ABERTO" | "EM_REENQUADRAMENTO" | "REENQUADRADO" | "JUSTIFICADO";

export interface AtivoCredito {
  id: string;
  nome: string;
  cnpj_emissor: string | null;
  tipo_ativo: TipoAtivo;
  tipo_instrumento: string | null;
  rating_externo: string | null;
  agencia_rating: string | null;
  data_emissao: string | null;
  data_vencimento: string | null;
  limite_percentual: number | null;
  prazo_revisao_dias: number;
  status: StatusAtivo;
  observacoes: string | null;
  /** Caminho no bucket `gestao-credito-atas` */
  ata_documento_storage_path?: string | null;
  criado_em: string;
  atualizado_em: string;
}

export interface MonitoramentoAgendaItem {
  id: string;
  ativo_id: string;
  data_proxima_revisao: string;
  status: StatusAgenda;
  tipo_gatilho: "PERIODICO" | "EVENTO_RELEVANTE" | "MANUAL";
  descricao_evento: string | null;
  criado_em: string;
  ativos_credito?: Pick<AtivoCredito, "nome" | "tipo_ativo" | "cnpj_emissor">;
}

export interface Desenquadramento {
  id: string;
  fundo_cnpj: string;
  fundo_nome: string | null;
  ativo_id: string | null;
  tipo_desenquadramento: TipoDesenquadramento;
  data_identificacao: string;
  descricao: string;
  valor_exposto: number | null;
  status: StatusDesenquadramento;
  plano_acao: string | null;
  data_prevista_reenquadramento: string | null;
  data_efetiva_reenquadramento: string | null;
  mercado_secundario_disponivel: boolean | null;
  informado_risco: boolean;
  informado_compliance: boolean;
  criado_em: string;
  atualizado_em: string;
  ativos_credito?: Pick<AtivoCredito, "nome" | "tipo_ativo"> | null;
}

export interface RegistrarAnalisePayload {
  tipo_analise: TipoAnalise;
  ativo_id?: string;
  tipo_ativo: TipoAtivo;
  analista: string;
  recomendacao: Recomendacao;
  dados_analise: {
    nome?: string;
    cnpj_emissor?: string;
    tipo_instrumento?: string;
    rating_externo?: string;
    agencia_rating?: string;
    data_emissao?: string;
    data_vencimento?: string;
    breve_historico: string;
    analise_esg?: string;
    risco_operacao?: string;
    observacoes?: string;
    // IF (CAMELS)
    if_sumario_financeiro?: Record<string, unknown>;
    if_estrutura_capital?: string;
    if_qualidade_carteira?: string;
    if_rentabilidade?: string;
    if_liquidez?: string;
    // Corporativo (Fitch)
    corp_risco_negocio?: string;
    corp_risco_financeiro?: string;
    corp_risco_refinanciamento?: string;
    corp_covenants?: string;
    // Estruturado (Fitch Trade Receivables)
    estr_estrutura_operacao?: string;
    estr_risco_carteira?: string;
    estr_risco_subordinacao?: string;
    estr_risco_originador?: string;
    estr_triggers?: string;
    /** Cota de fundo (campos auxiliares; breve_historico consolidado no submit) */
    cota_perfil?: string;
    cota_risco?: string;
    cota_gestor?: string;
  };
  decisao_comite?: {
    decisao: DecisaoComite;
    limite_aprovado_pct?: number;
    prazo_revisao_dias?: number;
    participantes?: string[];
    observacoes?: string;
    enviado_compliance?: boolean;
  };
}

export interface RegistrarDesenquadramentoPayload {
  fundo_cnpj: string;
  fundo_nome?: string;
  ativo_id?: string;
  tipo_desenquadramento: TipoDesenquadramento;
  descricao: string;
  valor_exposto?: number;
  mercado_secundario_disponivel?: boolean;
  plano_acao?: string;
  data_prevista_reenquadramento?: string;
}
