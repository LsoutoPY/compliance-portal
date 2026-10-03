export type TipoFundo = 'FI' | 'FIDC' | 'FIP' | 'FII'
export type Segmento = 'exclusivo_familiar' | 'alocacao' | 'asset' | 'prospeccao'
export type FormaCondominio = 'Aberto' | 'Fechado'

export interface FundoTaxa {
  id: string
  fundo_cnpj: string
  codigo: string | null
  responsabilidade: string | null
  tipo_fundo: TipoFundo
  exercicio_social: number | null
  pl_dez: number | null
  pl_jan: number
  qtd_cotistas: number | null
  forma_condominio: FormaCondominio | null
  publico_alvo: string | null
  /** Taxa de Gestão % a.a. (receita da Quadrante como gestor) */
  tg_percentual: number
  tg_minimo_mensal: number | null
  /** Taxa de gestão fixa mensal R$ (prioridade sobre % e mínimo) */
  tg_fixo_mensal: number | null
  /** Taxa de Administração % a.a. (paga ao administrador ex: INTRAG) */
  ta_percentual: number
  ta_minimo_mensal: number | null
  ta_fixo_mensal: number | null
  /** Taxa de Custódia % a.a. (paga ao custodiante ex: Itaú) */
  tc_percentual: number
  tc_minimo_mensal: number | null
  tc_fixo_mensal: number | null
  /** Taxa de Consultoria % a.a. */
  tcons_percentual: number
  tcons_minimo_mensal: number | null
  tcons_fixo_mensal: number | null
  /** Gross up: exibir valores brutos na apuração diária */
  gross_up_ativo?: boolean
  /** Alíquotas de gross up por tipo (decimal, ex: 0.0065 = 0,65%) */
  ta_gross_up_pis: number | null
  ta_gross_up_cofins: number | null
  ta_gross_up_iss: number | null
  tg_gross_up_pis: number | null
  tg_gross_up_cofins: number | null
  tg_gross_up_iss: number | null
  tc_gross_up_pis: number | null
  tc_gross_up_cofins: number | null
  tc_gross_up_iss: number | null
  tcons_gross_up_pis: number | null
  tcons_gross_up_cofins: number | null
  tcons_gross_up_iss: number | null
  segmento: Segmento
  ativo: boolean
  created_at: string
  updated_at: string
}

export interface FundoComReceita extends FundoTaxa {
  /** PL mais recente de posicao_carteira; cai para pl_jan se não houver posição */
  pl_atual: number
  data_posicao_atual: string | null
  /** PL de dezembro mais recente (posicao_carteira section caixa) */
  pl_dez_posicao: number | null
  data_pl_dez: string | null
  /** Cotistas distintos na última data de passivo_fundos */
  qtd_cotistas_passivo: number | null
  data_passivo_atual: string | null
  denominacao_social: string | null
  administrador: string | null
  cnpj_administrador: string | null
  gestor: string | null
  /** CNPJ do gestor (fundo_cnpjgestor do XML) */
  cnpj_gestor: string | null
  codigo_anbima: string | null
  categoria_anbima: string | null
  classificacao_anbima: string | null
  tg_efetiva: number | null
  /** Receita TG mensal (receita da Quadrante) */
  receita_mensal: number | null
  /** Taxa de Administração mensal calculada (informativo) */
  ta_receita_mensal: number | null
  /** Taxa de Custódia mensal calculada (informativo) */
  tc_receita_mensal: number | null
  /** Taxa de Consultoria mensal calculada (informativo) */
  tcons_receita_mensal: number | null
  no_minimo: boolean
}

export interface PLPorInstituicao {
  administrador: string
  cnpj_administrador: string
  data_referencia: string | null
  qtd_fundos: number
  pl_total: number
  receita_tg_total: number
  receita_ta_total: number
  receita_tc_total: number
}

export interface FundoPLHistorico {
  id: string
  fundo_cnpj: string
  mes_ref: string
  pl_valor: number
  created_at: string
}

/** PL mensal derivado de posicao_carteira (vw_pl_historico_mensal) */
export interface PLHistoricoMensal {
  fundo_cnpj: string
  mes_ref: string
  pl_valor: number
  data_referencia: string
}

export interface FundoTaxaFormData {
  fundo_cnpj: string
  codigo?: string
  responsabilidade?: string
  tipo_fundo: TipoFundo
  exercicio_social?: number | null
  pl_dez?: number | null
  pl_jan: number
  qtd_cotistas?: number | null
  forma_condominio?: FormaCondominio
  publico_alvo?: string
  tg_percentual: number
  tg_minimo_mensal?: number | null
  tg_fixo_mensal?: number | null
  ta_percentual: number
  ta_minimo_mensal?: number | null
  ta_fixo_mensal?: number | null
  tc_percentual: number
  tc_minimo_mensal?: number | null
  tc_fixo_mensal?: number | null
  tcons_percentual: number
  tcons_minimo_mensal?: number | null
  tcons_fixo_mensal?: number | null
  gross_up_ativo?: boolean
  ta_gross_up_pis?: number | null
  ta_gross_up_cofins?: number | null
  ta_gross_up_iss?: number | null
  tg_gross_up_pis?: number | null
  tg_gross_up_cofins?: number | null
  tg_gross_up_iss?: number | null
  tc_gross_up_pis?: number | null
  tc_gross_up_cofins?: number | null
  tc_gross_up_iss?: number | null
  tcons_gross_up_pis?: number | null
  tcons_gross_up_cofins?: number | null
  tcons_gross_up_iss?: number | null
  segmento: Segmento
}

/** Alíquotas PIS + COFINS + ISS para gross up de um tipo de taxa */
export interface GrossUpAliquotas {
  pis: number
  cofins: number
  iss: number
}

export interface FundosFiltros {
  segmento?: Segmento | ''
  tipo_fundo?: string
  administrador?: string
  gestor?: string
}

export const SEGMENTO_LABELS: Record<Segmento, string> = {
  exclusivo_familiar: 'Exclusivo familiar',
  alocacao: 'Alocação',
  asset: 'Asset',
  prospeccao: 'Prospecção',
}

export const SEGMENTO_COLORS: Record<Segmento, string> = {
  exclusivo_familiar: '#185FA5',
  alocacao: '#1D9E75',
  asset: '#73726C',
  prospeccao: '#888780',
}

export const SEGMENTO_ORDER: Segmento[] = [
  'exclusivo_familiar',
  'alocacao',
  'asset',
  'prospeccao',
]

export const TIPO_FUNDO_COLORS: Record<TipoFundo, { bg: string; text: string }> = {
  FI:   { bg: '#E6F1FB', text: '#0C447C' },
  FIDC: { bg: '#FAEEDA', text: '#633806' },
  FIP:  { bg: '#EEEDFE', text: '#3C3489' },
  FII:  { bg: '#EAF3DE', text: '#27500A' },
}

export const TIPO_FUNDO_OPTIONS: { value: TipoFundo; label: string }[] = [
  { value: 'FI',   label: 'FI' },
  { value: 'FIDC', label: 'FIDC' },
  { value: 'FIP',  label: 'FIP' },
  { value: 'FII',  label: 'FII' },
]

export const SEGMENTO_OPTIONS: { value: Segmento; label: string }[] = [
  { value: 'exclusivo_familiar', label: 'Exclusivo familiar' },
  { value: 'alocacao',           label: 'Alocação' },
  { value: 'asset',              label: 'Asset' },
  { value: 'prospeccao',         label: 'Prospecção' },
]
