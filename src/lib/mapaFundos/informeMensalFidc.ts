import { cnpjEstrutura, type MetricaEstrutura } from './estrutura';

export interface LinhaInformeMensalFidc {
  cnpj_fundo_classe: string | null;
  cnpj_fundo: string | null;
  cnpj_classe: string | null;
  dt_comptc: string | null;
  pl: number | null;
  numero_cotistas?: number | null;
  origem_tabela?: string | null;
  arquivo_origem: string | null;
}

function cnpjPedido(row: LinhaInformeMensalFidc, pedidos: Set<string>): string | undefined {
  return [row.cnpj_fundo_classe, row.cnpj_classe, row.cnpj_fundo].map(cnpjEstrutura).find(c => pedidos.has(c));
}

function dataIso(value: string): string {
  return value.slice(0, 10);
}

/**
 * PL vem da TAB_IV (competência mais recente). Cotistas somam as subclasses
 * da TAB_X_1 na competência mais recente daquele CNPJ.
 */
export function consolidarMetricasInformeMensalFidc(rows: LinhaInformeMensalFidc[], cnpjs: string[]): MetricaEstrutura[] {
  const pedidos = new Set(cnpjs);
  const plPorFundo = new Map<string, { data: string; pl: number; arquivo: string | null }>();
  const cotistasPorFundo = new Map<string, { data: string; cotistas: number; arquivo: string | null }>();

  for (const row of rows) {
    const cnpj = cnpjPedido(row, pedidos);
    if (!cnpj || !row.dt_comptc) continue;
    const data = dataIso(row.dt_comptc);
    if (row.origem_tabela === 'TAB_IV_PARTE_A' && row.pl != null) {
      const atual = plPorFundo.get(cnpj);
      if (!atual || data > atual.data) plPorFundo.set(cnpj, { data, pl: Number(row.pl), arquivo: row.arquivo_origem });
    }
    if (row.origem_tabela === 'TAB_X_1' && row.numero_cotistas != null && row.numero_cotistas >= 0) {
      const atual = cotistasPorFundo.get(cnpj);
      if (!atual || data > atual.data) {
        cotistasPorFundo.set(cnpj, { data, cotistas: row.numero_cotistas, arquivo: row.arquivo_origem });
      } else if (data === atual.data) {
        atual.cotistas += row.numero_cotistas;
      }
    }
  }

  const chaves = new Set([...plPorFundo.keys(), ...cotistasPorFundo.keys()]);
  return [...chaves].map(cnpj => {
    const pl = plPorFundo.get(cnpj);
    const cotistas = cotistasPorFundo.get(cnpj);
    return {
      fundo_cnpj: cnpj,
      data_competencia: pl?.data ?? cotistas!.data,
      patrimonio_liquido: pl?.pl ?? null,
      numero_cotistas: cotistas?.cotistas ?? null,
      origem: 'informe_mensal_fidc',
      arquivo_origem: pl?.arquivo ?? cotistas?.arquivo ?? null,
    };
  });
}
