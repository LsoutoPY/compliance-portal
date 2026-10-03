import type { CoberturaPddRow, VisaoGeralKpis } from "./creditoMatriz";

export type PddResumo = Pick<VisaoGeralKpis,
  "doc_fundo" | "nome_fundo" | "data_referencia" | "vp_total" | "pdd_total" |
  "vp_a_vencer" | "vp_vencido" | "vp_writeoff">;

export interface PddReportInput {
  fund: string;
  date: string;
  resumos: PddResumo[];
  coberturas: CoberturaPddRow[];
  generatedAt?: Date;
}

export const pddRatio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

export function buildPddReport(input: PddReportInput) {
  if (!input.date || !input.fund || !input.resumos.length) {
    throw new Error("Não há dados de PDD para o fundo e a data-base selecionados.");
  }
  const keys = new Set<string>();
  const bucketKeys = new Set<string>();
  const assertScope = (row: { doc_fundo: string; data_referencia: string }) => {
    if (row.data_referencia !== input.date || (input.fund !== "TODOS" && row.doc_fundo !== input.fund)) {
      throw new Error("Os dados não correspondem ao fundo e à data-base selecionados. Atualize a consulta.");
    }
  };
  const assertNumbers = (values: number[]) => {
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("Há valores ausentes ou inválidos nos dados de PDD. Verifique o estoque.");
    }
  };
  for (const row of input.resumos) {
    assertScope(row);
    assertNumbers([row.vp_total, row.pdd_total, row.vp_a_vencer, row.vp_vencido, row.vp_writeoff]);
    if (keys.has(row.doc_fundo)) throw new Error("Há resumos duplicados para o mesmo fundo.");
    keys.add(row.doc_fundo);
  }
  for (const row of input.coberturas) {
    assertScope(row);
    assertNumbers([row.vp_total_faixa, row.vp_pdd_faixa, row.faixa_prazo_ordem]);
    const key = `${row.doc_fundo}:${row.faixa_prazo_ordem}`;
    if (!keys.has(row.doc_fundo) || bucketKeys.has(key)) {
      throw new Error("As faixas de PDD estão duplicadas ou sem resumo correspondente.");
    }
    bucketKeys.add(key);
  }

  const funds = [...input.resumos].sort((a, b) => a.nome_fundo.localeCompare(b.nome_fundo, "pt-BR"))
    .map((resumo) => {
      const faixas = input.coberturas.filter((row) => row.doc_fundo === resumo.doc_fundo)
        .sort((a, b) => a.faixa_prazo_ordem - b.faixa_prazo_ordem);
      const vp = faixas.reduce((sum, row) => sum + row.vp_total_faixa, 0);
      const pdd = faixas.reduce((sum, row) => sum + row.vp_pdd_faixa, 0);
      // Compara valores brutos antes do arredondamento de exibição; tolerância de um centavo.
      if (!faixas.length || Math.abs(vp - resumo.vp_total) > 0.011 || Math.abs(pdd - resumo.pdd_total) > 0.011) {
        throw new Error(`Os totais e as faixas de ${resumo.nome_fundo} não conciliam. Atualize os dados antes de exportar.`);
      }
      return { ...resumo, faixas };
    });

  const totals = funds.reduce((acc, row) => ({
    vp: acc.vp + row.vp_total,
    pdd: acc.pdd + row.pdd_total,
    adimplente: acc.adimplente + row.vp_a_vencer,
    vencido: acc.vencido + row.vp_vencido,
    writeoff: acc.writeoff + row.vp_writeoff,
  }), { vp: 0, pdd: 0, adimplente: 0, vencido: 0, writeoff: 0 });

  const buckets = new Map<number, { label: string; order: number; vp: number; pdd: number }>();
  for (const row of input.coberturas) {
    const bucket = buckets.get(row.faixa_prazo_ordem) ?? {
      label: row.faixa_prazo, order: row.faixa_prazo_ordem, vp: 0, pdd: 0,
    };
    bucket.vp += row.vp_total_faixa;
    bucket.pdd += row.vp_pdd_faixa;
    buckets.set(bucket.order, bucket);
  }
  return {
    ...input, generatedAt: input.generatedAt ?? new Date(), funds, totals,
    buckets: [...buckets.values()].sort((a, b) => a.order - b.order),
  };
}

export type PddReport = ReturnType<typeof buildPddReport>;
