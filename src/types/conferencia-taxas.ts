// ── Tipos: Conferência de Taxas (Fase 1 — Apuração Diária) ────────────────
//
// Fase 1: calcular e exibir a provisão diária estimada (TA/TG/TC/TCons)
//         com base no PL de posicao_carteira e taxas de fundos_taxas.
//
// Fase 2 (futura): split condicional TA/TG a partir de cod 34 (slot + atribuição por fundo).

/** Linha diária de apuração de taxas por fundo */
export interface ConferenciaTaxaDiaria {
  fundo_cnpj: string
  data_ref: string        // "YYYY-MM-DD"
  pl_dia: number          // PL da data de posição (posicao_carteira)
  pl_anterior: number | null  // PL do dia útil anterior (referência; cálculo usa pl_dia)
  // Taxa de Administração — componentes separados
  ta_pct_dia: number      // pl_dia × ta% / 252
  ta_min_dia: number      // ta_minimo_mensal / dias_uteis_no_mes
  ta_efetivo_dia: number  // max(pct, mín) | 0 se sem PL
  // Taxa de Gestão
  tg_efetivo_dia: number
  // Taxa de Custódia
  tc_efetivo_dia: number
  // Taxa de Consultoria
  tcons_efetivo_dia: number
}

/** Resumo mensal por fundo */
export interface ConferenciaTaxaMes {
  fundo_cnpj: string
  mes_ref: string         // "YYYY-MM"
  denominacao_social: string
  administrador: string | null
  gestor: string | null
  segmento: string
  tipo_fundo: string
  // Configuração vigente (para exibição no painel de detalhes)
  ta_percentual: number
  ta_minimo_mensal: number | null
  ta_fixo_mensal: number | null
  tg_percentual: number
  tg_minimo_mensal: number | null
  tg_fixo_mensal: number | null
  tc_percentual: number
  tc_minimo_mensal: number | null
  tc_fixo_mensal: number | null
  tcons_percentual: number
  tcons_minimo_mensal: number | null
  tcons_fixo_mensal: number | null
  // Gross up (PIS + COFINS + ISS por tipo de taxa)
  gross_up_ativo?: boolean
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
  // Flags de taxas ativas (badges na UI)
  tem_ta: boolean
  tem_tg: boolean
  tem_tc: boolean
  tem_tcons: boolean
  // Acumulados mensais
  ta_mensal: number
  tg_mensal: number
  tc_mensal: number
  tcons_mensal: number
  total_mensal: number
  // PL último dia útil do mês
  pl_ultimo: number
  qtd_dias_uteis: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Retorna "YYYY-MM" do mês atual */
export function mesRefAtual(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** "YYYY-MM" → "MM/YYYY" (formato despesas_fundo.mes_ano) */
export function mesRefToMesAno(mesRef: string): string {
  const [y, m] = mesRef.split('-')
  return `${m}/${y}`
}

/** Valores informados pela administradora (despesas_fundo) */
export interface ReferenciaDespesas {
  ta: number | null
  tg: number | null
  tc: number | null
  total: number | null
}

/** Provisões de taxas no XML (posicao_carteira) — último snapshot do mês */
export interface ReferenciaProvisoesMes {
  fundo_cnpj: string
  mes_ref: string
  data_snapshot: string
  dt_provisao_ta_tg: string | null
  dt_provisao_tc: string | null
  tc: number
  ta_tg_agregado: number
  total_taxas: number
  qtd_linhas_cod34: number
  qtd_linhas_cod15: number
}

/** Linha bruta de provisão (drill-down) */
export interface ProvisaoTaxaDetalhe {
  fundo_cnpj: string
  mes_ref: string
  data_snapshot: string
  codprov: string
  dt_provisao: string
  credeb: string
  valor: number
  slot: number
}

/** "YYYY-MM" → primeiro e último dia do mês como strings "YYYY-MM-DD" */
export function intervaloMes(mesRef: string): { inicio: string; fim: string } {
  const [y, m] = mesRef.split('-').map(Number)
  const ultimo = new Date(y, m, 0).getDate()
  return {
    inicio: `${mesRef}-01`,
    fim: `${mesRef}-${String(ultimo).padStart(2, '0')}`,
  }
}

/** Navega um mês para frente ou para trás a partir de "YYYY-MM" */
export function navegarMes(mesRef: string, delta: -1 | 1): string {
  const [y, m] = mesRef.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** "YYYY-MM" → "Janeiro/2026" */
export function fmtMesRefLongo(mesRef: string): string {
  const meses = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
  ]
  const [y, m] = mesRef.split('-').map(Number)
  return `${meses[m - 1]}/${y}`
}
