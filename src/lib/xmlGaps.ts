import { supabase } from "@/integrations/supabase/client";

/** Linha retornada por get_xml_gaps_por_referencia (cota válida + janela ativa). */
export interface XmlGapRow {
  fundo_cnpj: string;
  fundo_isin: string;
  nome_fundo: string;
  data_faltante: string;
}

/** Linha retornada por get_xml_gaps (legado — tela de importação). */
export interface XmlGapRowLegacy {
  fundo_cnpj: string;
  nome_fundo: string;
  data_faltante: string;
}

export const XML_GAPS_ANOS_RETRO = 2;

/** Alinhado com DIAS_INATIVO_RENTABILIDADE_XML (useRentabilidadeCalc.ts). */
export const XML_GAPS_JANELA_DIAS = 10;

/** Intervalo YYYYMMDD: 01/01 do ano até data ref (ano corrente) ou 31/12 (anos anteriores). */
export function resolveXmlGapsIntervalo(
  dataFimRefYyyymmdd: string,
  ano: number,
): { dataInicio: string; dataFim: string } {
  const refYear = Number(dataFimRefYyyymmdd.slice(0, 4));
  const dataInicio = `${ano}0101`;

  if (ano > refYear) {
    return { dataInicio, dataFim: dataInicio };
  }

  const dataFim =
    ano === refYear ? dataFimRefYyyymmdd : `${ano}1231`;

  return { dataInicio, dataFim };
}

/** Anos selecionáveis no modal (ano da ref + anteriores). */
export function listarAnosXmlGaps(dataFimRefYyyymmdd: string): number[] {
  const refYear = Number(dataFimRefYyyymmdd.slice(0, 4));
  return Array.from({ length: XML_GAPS_ANOS_RETRO + 1 }, (_, i) => refYear - i);
}

export function formatGapDateYyyymmdd(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(0, 4)}`;
}

export function buildFundGapKey(cnpj: string, isin: string): string {
  return `${cnpj}|${isin ?? ""}`;
}

export interface XmlGapPorFundo {
  fundo_cnpj: string;
  fundo_isin: string;
  nome_fundo: string;
  datas: string[];
  datasFmt: string[];
}

export interface XmlGapPorData {
  data_faltante: string;
  dataFmt: string;
  fundos: { fundo_cnpj: string; fundo_isin: string; nome_fundo: string }[];
  loteCompleto: boolean;
}

export interface XmlGapsGrouped {
  totalGaps: number;
  totalFundosComGap: number;
  totalFundosUniverso: number;
  datasLoteCompleto: string[];
  porFundo: XmlGapPorFundo[];
  porData: XmlGapPorData[];
  janelaInicio: string | null;
  janelaFim: string | null;
}

export interface XmlGapsFetchResult {
  gaps: XmlGapRow[];
  totalFundosUniverso: number;
}

interface XmlGapRowRaw extends XmlGapRow {
  total_fundos_universo?: number;
}

/** Busca gaps via RPC por intervalo (Dashboard). */
export async function fetchXmlGapsPorReferencia(
  dataInicioYyyymmdd: string,
  dataFimYyyymmdd: string,
): Promise<XmlGapsFetchResult> {
  const [gapsRes, countRes] = await Promise.all([
    supabase.rpc("get_xml_gaps_por_referencia" as never, {
      p_data_inicio: dataInicioYyyymmdd,
      p_data_fim: dataFimYyyymmdd,
    } as never),
    supabase.rpc("get_xml_universo_count" as never, {
      p_data_inicio: dataInicioYyyymmdd,
      p_data_fim: dataFimYyyymmdd,
    } as never),
  ]);

  if (gapsRes.error) throw gapsRes.error;
  if (countRes.error) throw countRes.error;

  const raw = (gapsRes.data ?? []) as XmlGapRowRaw[];
  const totalFromRow = raw[0]?.total_fundos_universo;
  const totalFundosUniverso =
    typeof totalFromRow === "number"
      ? totalFromRow
      : typeof countRes.data === "number"
        ? countRes.data
        : 0;

  const gaps: XmlGapRow[] = raw.map(({ fundo_cnpj, fundo_isin, nome_fundo, data_faltante }) => ({
    fundo_cnpj,
    fundo_isin,
    nome_fundo,
    data_faltante,
  }));

  return { gaps, totalFundosUniverso };
}

/** Busca gaps via RPC legada (ImportXml). */
export async function fetchXmlGapsLegacy(): Promise<XmlGapRowLegacy[]> {
  const { data, error } = await supabase.rpc("get_xml_gaps" as never);
  if (error) throw error;
  return (data ?? []) as XmlGapRowLegacy[];
}

export function groupXmlGaps(
  rows: XmlGapRow[],
  intervalo?: { dataInicio: string; dataFim: string },
  totalFundosUniversoOverride?: number,
): XmlGapsGrouped {
  const dataInicio = intervalo?.dataInicio ?? null;
  const dataFim = intervalo?.dataFim ?? null;

  if (rows.length === 0) {
    return {
      totalGaps: 0,
      totalFundosComGap: 0,
      totalFundosUniverso: totalFundosUniversoOverride ?? 0,
      datasLoteCompleto: [],
      porFundo: [],
      porData: [],
      janelaInicio: dataInicio,
      janelaFim: dataFim,
    };
  }

  const totalFundosUniverso = totalFundosUniversoOverride ?? new Set(
    rows.map((r) => buildFundGapKey(r.fundo_cnpj, r.fundo_isin)),
  ).size;

  const porDataMap = new Map<
    string,
    { fundo_cnpj: string; fundo_isin: string; nome_fundo: string }[]
  >();

  for (const row of rows) {
    const list = porDataMap.get(row.data_faltante) ?? [];
    list.push({
      fundo_cnpj: row.fundo_cnpj,
      fundo_isin: row.fundo_isin,
      nome_fundo: row.nome_fundo,
    });
    porDataMap.set(row.data_faltante, list);
  }

  const datasLoteCompleto = [...porDataMap.entries()]
    .filter(([, fundos]) => fundos.length >= totalFundosUniverso)
    .map(([dt]) => dt)
    .sort((a, b) => b.localeCompare(a));

  const loteSet = new Set(datasLoteCompleto);

  const porFundoMap = new Map<string, XmlGapPorFundo>();
  for (const row of rows) {
    if (loteSet.has(row.data_faltante)) continue;
    const key = buildFundGapKey(row.fundo_cnpj, row.fundo_isin);
    const existing = porFundoMap.get(key);
    if (existing) {
      existing.datas.push(row.data_faltante);
    } else {
      porFundoMap.set(key, {
        fundo_cnpj: row.fundo_cnpj,
        fundo_isin: row.fundo_isin,
        nome_fundo: row.nome_fundo,
        datas: [row.data_faltante],
        datasFmt: [],
      });
    }
  }

  const porFundo = [...porFundoMap.values()]
    .map((f) => ({
      ...f,
      datas: [...f.datas].sort((a, b) => b.localeCompare(a)),
      datasFmt: [...f.datas]
        .sort((a, b) => b.localeCompare(a))
        .map(formatGapDateYyyymmdd),
    }))
    .sort((a, b) =>
      (a.nome_fundo || "").localeCompare(b.nome_fundo || "", "pt-BR"),
    );

  const porData: XmlGapPorData[] = [...porDataMap.entries()]
    .map(([data_faltante, fundos]) => ({
      data_faltante,
      dataFmt: formatGapDateYyyymmdd(data_faltante),
      fundos: fundos.sort((a, b) =>
        (a.nome_fundo || "").localeCompare(b.nome_fundo || "", "pt-BR"),
      ),
      loteCompleto: fundos.length >= totalFundosUniverso,
    }))
    .sort((a, b) => b.data_faltante.localeCompare(a.data_faltante));

  const fundosComGapIndividuais = new Set(
    rows.filter((r) => !loteSet.has(r.data_faltante)).map((r) => r.fundo_cnpj),
  );

  return {
    totalGaps: rows.length,
    totalFundosComGap: fundosComGapIndividuais.size || new Set(rows.map((r) => r.fundo_cnpj)).size,
    totalFundosUniverso,
    datasLoteCompleto,
    porFundo,
    porData,
    janelaInicio: dataInicio,
    janelaFim: dataFim,
  };
}

/** Gera lista de dias úteis (Seg–Sex) entre duas datas YYYYMMDD, inclusive. */
export function gerarDiasUteis(
  inicioYyyymmdd: string,
  fimYyyymmdd: string,
): string[] {
  const parse = (s: string) =>
    new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));

  const inicio = parse(inicioYyyymmdd);
  const fim = parse(fimYyyymmdd);
  const dias: string[] = [];

  const cur = new Date(inicio);
  while (cur <= fim) {
    const dow = cur.getDay();
    if (dow >= 1 && dow <= 5) {
      dias.push(
        [
          cur.getFullYear(),
          String(cur.getMonth() + 1).padStart(2, "0"),
          String(cur.getDate()).padStart(2, "0"),
        ].join(""),
      );
    }
    cur.setDate(cur.getDate() + 1);
  }

  return dias;
}
