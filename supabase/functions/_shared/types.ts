// Shared types for Edge Functions

export type RuleStatus = 'ok' | 'alerta' | 'violacao';
export type RuleCategory = 'pl' | 'concentration' | 'liquidity' | 'classe';

export interface RuleResult {
  regra_codigo: string;
  regra_descricao: string;
  status: RuleStatus;
  valor_atual: number | null;
  valor_limite: number | null;
  detalhes?: Record<string, unknown>;
}

export interface EnquadramentoResultado {
  id?: string;
  fundo_cnpj: string;
  fundo_dtposicao: string;
  regra_categoria: RuleCategory;
  regra_codigo: string;
  regra_descricao: string | null;
  status: RuleStatus;
  valor_atual: number | null;
  valor_limite: number | null;
  detalhes: Record<string, unknown> | null;
  verificado_em?: string;
}

export interface RuleCheckRequest {
  fundo_cnpj: string;
  fundo_dtposicao: string;
}

export interface RuleCheckResponse {
  success: boolean;
  results: RuleResult[];
  error?: string;
}

// Position data from posicao_carteira table
export interface PosicaoCarteira {
  id: string;
  natural_key: string;
  fundo_cnpj: string;
  fundo_dtposicao: string;
  nome_fundo: string | null;
  section: 'cotas' | 'titpublico' | 'titprivado' | 'despesas' | 'provisao' | 'caixa' | 'participacoes';
  fundo_patliq: number | null;
  fundo_valorcota: number | null;
  fundo_quantidade: number | null;
  fundo_valorativos: number | null;
  valorfindisp: number | null;
  valor_padrao: number | null; // Valor financeiro padronizado por seção
  isin: string | null;
  cnpjemissor: string | null;
  cnpjfundo: string | null;
  saldo: number | null;
  // ... other fields as needed
}

// Rule configuration
export interface RuleConfig {
  codigo: string;
  descricao: string;
  categoria: RuleCategory;
  limite: number;
  limiteAlerta?: number; // Optional threshold for 'alerta' status
  enabled: boolean;
}

// PL Rules configuration
export const PL_RULES: RuleConfig[] = [
  {
    codigo: 'PL_MIN',
    descricao: 'Patrimônio Líquido mínimo de R$ 1.000.000,00',
    categoria: 'pl',
    limite: 1000000,
    limiteAlerta: 1200000, // Alert if PL is below R$ 1.2M (20% margin)
    enabled: true,
  },
];

// Concentration Rules configuration
export const CONCENTRATION_RULES: RuleConfig[] = [
  {
    codigo: 'CONC_EMISSOR_10',
    descricao: 'Concentração máxima de 10% em um único emissor',
    categoria: 'concentration',
    limite: 0.10, // 10%
    limiteAlerta: 0.08, // Alert at 8%
    enabled: true,
  },
];

// Liquidity Rules configuration
export const LIQUIDITY_RULES: RuleConfig[] = [
  {
    codigo: 'LIQ_CAIXA_MIN',
    descricao: 'Mínimo de 5% do PL em caixa',
    categoria: 'liquidity',
    limite: 0.05, // 5%
    limiteAlerta: 0.07, // Alert if below 7%
    enabled: true,
  },
];

// Classe Rules configuration
export const CLASSE_RULES: RuleConfig[] = [
  {
    codigo: 'CLASSE_FIDC_67',
    descricao: 'Mínimo de 67% do investimento em FIDCs (para fundos FIDC)',
    categoria: 'classe',
    limite: 0.67, // 67%
    limiteAlerta: 0.70, // Alerta se cair abaixo de 70% (margem de segurança)
    enabled: true,
  },
  {
    codigo: 'CLASSE_FIP_90',
    descricao: 'Mínimo de 90% em empresas-alvo de participações (para fundos FIP)',
    categoria: 'classe',
    limite: 0.90, // 90%
    limiteAlerta: 0.92, // Alerta se cair abaixo de 92% (margem de segurança)
    enabled: true,
  },
];
