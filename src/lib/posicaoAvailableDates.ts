import { supabase } from "@/integrations/supabase/client";

/**
 * Datas com posição XML importada (YYYYMMDD), mais recente primeiro.
 * Preferência: view vw_posicao_datas_disponiveis (1 linha por data).
 * Fallback: paginação em posicao_carteira (para ambientes sem a view).
 */
export async function fetchPosicaoAvailableDates(): Promise<string[]> {
  const { data, error } = await supabase
    .from("vw_posicao_datas_disponiveis" as any)
    .select("fundo_dtposicao")
    .order("fundo_dtposicao", { ascending: false });

  if (!error && data?.length) {
    return (data as Array<{ fundo_dtposicao: string }>)
      .map((d) => d.fundo_dtposicao)
      .filter(Boolean);
  }

  if (error) {
    console.warn(
      "[fetchPosicaoAvailableDates] View indisponível, usando fallback paginado:",
      error.message
    );
  }

  const dates = new Set<string>();
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data: rows, error: pageError } = await supabase
      .from("posicao_carteira")
      .select("fundo_dtposicao")
      .in("section", ["caixa", "despesas"])
      .order("fundo_dtposicao", { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (pageError) {
      console.error("[fetchPosicaoAvailableDates] Erro no fallback:", pageError);
      break;
    }
    if (!rows?.length) break;

    for (const row of rows) {
      if (row.fundo_dtposicao) dates.add(row.fundo_dtposicao);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return [...dates].sort((a, b) => b.localeCompare(a));
}
