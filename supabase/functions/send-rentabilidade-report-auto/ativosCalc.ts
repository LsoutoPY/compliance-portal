/**
 * Cálculos e mapeamento de ativos — porte Deno de `src/hooks/useRentabilidadeCalc.ts`
 * (subset usado pelo drill-down de ativos no relatório detalhado).
 */

import { resolveNomeFromLookupMap } from "./mapaAtivosNome.ts";
import {
  isIsinMascarado,
  isinUtilizavel,
  yyyymmddToIso,
} from "./calc.ts";

export const SECTIONS_ATIVOS_RENTABILIDADE = [
  "cotas",
  "titpublico",
  "titprivado",
  "acoes",
  "participacoes",
  "imoveis",
] as const;

export interface PosicaoAtivo {
  fundo_cnpj: string;
  data_posicao: string;
  ativo_key: string;
  section: string;
  cnpj_ativo: string | null;
  isin_ativo: string | null;
  nome_ativo?: string | null;
  nome_exibicao: string;
  qt_disponivel: number | null;
  pu_posicao: number | null;
}

export interface PosicaoCarteiraRow {
  fundo_cnpj: string;
  fundo_isin?: string | null;
  fundo_dtposicao: string;
  fundo_valorcota?: number | null;
  fundo_patliq?: number | null;
  fundo_valorativos?: number | null;
  fundo_quantidade?: number | null;
  nome_fundo?: string | null;
  fundo_nome?: string | null;
  fundo_nomeadm?: string | null;
  fundo_cnpjgestor?: string | null;
  section?: string;
  cnpjfundo?: string | null;
  cnpjemissor?: string | null;
  cnpjpart?: string | null;
  cnpjemp?: string | null;
  qtdisponivel?: number | null;
  puposicao?: number | null;
  isin?: string | null;
  codativo?: string | null;
  nomecomercial?: string | null;
  matricula?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  valor_padrao?: number | null;
  valorcontabil?: number | null;
  dtemissao?: string | null;
  dtvencimento?: string | null;
  ativos?: {
    cnpj?: string | null;
    isin?: string | null;
    tipo_ativo?: string | null;
    nome_frontend?: string | null;
    descricao?: string | null;
  } | null;
}

export interface RentabilidadeAtivoRow {
  ativo_key: string;
  section: string;
  cnpj_ativo: string | null;
  isin_ativo: string | null;
  nome_ativo: string | null;
  nome_exibicao: string;
  qt_disponivel: number | null;
  pu_posicao: number | null;
  vl_mercado: number | null;
  perc_pl_pct: number | null;
  var_pu_pct: number | null;
  var_pu_mes_pct: number | null;
  var_pu_ano_pct: number | null;
  var_pu_12m_pct: number | null;
  pct_cdi: number | null;
  cdi_plus_dia_pct: number | null;
  cdi_plus_aa_pct: number | null;
  pct_cdi_mes: number | null;
  cdi_plus_mes_pct: number | null;
  cdi_plus_aa_mes_pct: number | null;
  pct_cdi_ano: number | null;
  cdi_plus_ano_pct: number | null;
  cdi_plus_aa_ano_pct: number | null;
  pct_cdi_12m: number | null;
  cdi_plus_12m_pct: number | null;
  cdi_plus_aa_12m_pct: number | null;
  is_fidc: boolean;
}

export function cnpjFromCotasAtivoKey(ativoKey: string): string | null {
  const m = /^cotas:cnpj:(\d+)/i.exec(ativoKey);
  return m?.[1] ?? null;
}

export function posicoesAtivoEquivalentes(
  a: Pick<PosicaoAtivo, "qt_disponivel" | "pu_posicao">,
  b: Pick<PosicaoAtivo, "qt_disponivel" | "pu_posicao">,
): boolean {
  const qtA = a.qt_disponivel ?? 0;
  const qtB = b.qt_disponivel ?? 0;
  const puA = a.pu_posicao ?? 0;
  const puB = b.pu_posicao ?? 0;
  if (Math.abs(qtA - qtB) > 1e-4) return false;
  if (qtA === 0 && qtB === 0) return true;
  return Math.abs(puA - puB) <= Math.max(1e-8, Math.abs(puA) * 1e-9);
}

function fundirPosicoesAtivo(grupo: PosicaoAtivo[]): PosicaoAtivo {
  let qtAcum = 0;
  let puPond = 0;
  let preferido = grupo[0];
  for (const a of grupo) {
    const qt = a.qt_disponivel ?? 0;
    const pu = a.pu_posicao ?? 0;
    qtAcum += qt;
    puPond += pu * qt;
    if (isinUtilizavel(a.isin_ativo) && !isinUtilizavel(preferido.isin_ativo)) {
      preferido = a;
    }
  }
  return {
    ...preferido,
    qt_disponivel: qtAcum,
    pu_posicao: qtAcum > 0 ? puPond / qtAcum : preferido.pu_posicao,
    ativo_key: isinUtilizavel(preferido.isin_ativo)
      ? `cotas:cnpj:${preferido.cnpj_ativo?.replace(/\D/g, "")}:isin:${isinUtilizavel(preferido.isin_ativo)}`
      : `cotas:cnpj:${preferido.cnpj_ativo?.replace(/\D/g, "")}`,
  };
}

export function deduplicarCotasPorCnpj(ativos: PosicaoAtivo[]): PosicaoAtivo[] {
  const outros: PosicaoAtivo[] = [];
  const porCnpj = new Map<string, PosicaoAtivo[]>();

  for (const a of ativos) {
    if (a.section !== "cotas") {
      outros.push(a);
      continue;
    }
    const cnpj = a.cnpj_ativo?.replace(/\D/g, "");
    if (!cnpj) {
      outros.push(a);
      continue;
    }
    const list = porCnpj.get(cnpj) ?? [];
    list.push(a);
    porCnpj.set(cnpj, list);
  }

  const cotasOut: PosicaoAtivo[] = [];
  for (const grupo of porCnpj.values()) {
    if (grupo.length === 1) {
      cotasOut.push(grupo[0]);
      continue;
    }

    const comIsinReal = grupo.filter((a) => isinUtilizavel(a.isin_ativo));
    if (comIsinReal.length === 0) {
      cotasOut.push(fundirPosicoesAtivo(grupo));
      continue;
    }

    const mantidos: PosicaoAtivo[] = [];
    for (const real of comIsinReal) {
      const jaTem = mantidos.some(
        (m) =>
          isinUtilizavel(m.isin_ativo) === isinUtilizavel(real.isin_ativo) &&
          posicoesAtivoEquivalentes(m, real),
      );
      if (!jaTem) mantidos.push(real);
    }

    for (const legado of grupo) {
      if (isinUtilizavel(legado.isin_ativo)) continue;
      const dup = mantidos.some((m) => posicoesAtivoEquivalentes(m, legado));
      if (!dup) mantidos.push(legado);
    }

    cotasOut.push(...mantidos);
  }

  return [...outros, ...cotasOut];
}

export function consolidarHistoricoPuCotas<
  T extends {
    ativo_key: string;
    data_posicao: string;
    pu_posicao: number;
    qt: number;
  },
>(rows: T[]): T[] {
  const outros: T[] = [];
  const map = new Map<string, T>();

  const scoreKey = (r: T) => {
    const isinPart = /:isin:([^:]+)$/i.exec(r.ativo_key)?.[1];
    if (!isinPart) return 0;
    return isIsinMascarado(isinPart) ? 1 : 2;
  };

  for (const r of rows) {
    if (!r.ativo_key.startsWith("cotas:")) {
      outros.push(r);
      continue;
    }
    const cnpj = cnpjFromCotasAtivoKey(r.ativo_key);
    if (!cnpj) {
      outros.push(r);
      continue;
    }

    const isinMatch = /:isin:([^:]+)$/i.exec(r.ativo_key);
    const isinPart = isinMatch?.[1] ?? null;
    const temIsinReal = isinPart != null && !isIsinMascarado(isinPart);

    const k = temIsinReal
      ? `${cnpj}|${isinPart}|${r.data_posicao}`
      : `${cnpj}||${r.data_posicao}`;

    const existente = map.get(k);
    if (!existente || scoreKey(r) > scoreKey(existente)) {
      map.set(k, r);
    }
  }

  return [...outros, ...map.values()];
}

export function getAtivoKeyFromRow(row: PosicaoCarteiraRow): string {
  const section = (row.section || "cotas").toLowerCase();
  switch (section) {
    case "cotas": {
      const cnpj = row.cnpjfundo?.replace(/\D/g, "");
      const isin = isinUtilizavel(row.isin);
      if (cnpj && isin) return `cotas:cnpj:${cnpj}:isin:${isin}`;
      if (cnpj) return `cotas:cnpj:${cnpj}`;
      const isinBruto = row.isin?.trim().toUpperCase();
      if (isinBruto) return `cotas:isin:${isinBruto}`;
      return `cotas:unk:${row.codativo?.trim() || "?"}`;
    }
    case "acoes":
      return `acoes:${row.codativo?.trim() || ""}:${row.isin?.trim() || ""}`;
    case "titpublico":
    case "titprivado":
    case "termorf":
      return [
        section,
        row.isin?.trim() || "",
        row.codativo?.trim() || "",
        row.cnpjemissor?.replace(/\D/g, "") || "",
        row.dtemissao || "",
        row.dtvencimento || "",
      ].join("|");
    case "participacoes": {
      const cnpj =
        row.cnpjpart?.replace(/\D/g, "") ||
        row.cnpjemissor?.replace(/\D/g, "") ||
        "";
      return `participacoes:${cnpj}:${row.nomecomercial?.trim() || ""}`;
    }
    case "imoveis": {
      const mat = row.matricula?.trim() || "";
      const addr = [row.logradouro, row.numero].filter(Boolean).join(",");
      return `imoveis:${mat}:${addr}:${row.nomecomercial?.trim() || ""}`;
    }
    default:
      return `${section}:${row.isin?.trim() || row.codativo?.trim() || row.cnpjfundo || "?"}`;
  }
}

export function expandAtivoKeyAliases(
  ativoKey: string,
  isinAtivo?: string | null,
): string[] {
  const keys = new Set<string>([ativoKey]);

  const cnpjIsin = /^cotas:cnpj:(\d+):isin:([A-Z0-9*]+)$/i.exec(ativoKey);
  if (cnpjIsin) {
    keys.add(`cotas:cnpj:${cnpjIsin[1]}`);
    if (!isIsinMascarado(cnpjIsin[2])) {
      keys.add(`cotas:isin:${cnpjIsin[2]}`);
    }
  }

  const cnpjOnly = /^cotas:cnpj:(\d+)$/i.exec(ativoKey);
  if (cnpjOnly) {
    const isin = isinAtivo?.trim().toUpperCase();
    if (isin) keys.add(`cotas:cnpj:${cnpjOnly[1]}:isin:${isin}`);
  }

  const isinOnly = /^cotas:isin:([A-Z0-9]+)$/i.exec(ativoKey);
  if (isinOnly) {
    keys.add(`cotas:isin:${isinOnly[1]}`);
  }

  return [...keys];
}

export function resolvePuQtFromRow(row: PosicaoCarteiraRow): {
  qt: number | null;
  pu: number | null;
  vlMercado: number | null;
} {
  const qt = row.qtdisponivel ?? null;
  const pu = row.puposicao ?? null;

  if (pu != null && qt != null && qt > 0) {
    return { qt, pu, vlMercado: qt * pu };
  }
  if (pu != null) {
    const q = qt ?? 1;
    return { qt: q, pu, vlMercado: q * pu };
  }

  const section = (row.section || "").toLowerCase();
  const vl = row.valor_padrao ?? row.valorcontabil ?? null;

  if (section === "imoveis" && vl != null && vl > 0) {
    return { qt: 1, pu: vl, vlMercado: vl };
  }
  if (vl != null && qt != null && qt > 0) {
    return { qt, pu: vl / qt, vlMercado: vl };
  }
  if (vl != null) {
    return { qt: 1, pu: vl, vlMercado: vl };
  }

  return { qt, pu, vlMercado: null };
}

export function ativoJoinNomeConfiavel(
  rowIsin: string | null,
  ativoJoin: PosicaoCarteiraRow["ativos"],
): string | null {
  if (!ativoJoin) return null;
  const nome = ativoJoin.nome_frontend?.trim() || ativoJoin.descricao?.trim() || null;
  if (!nome) return null;

  const joinIsin = isinUtilizavel(ativoJoin.isin);
  if (rowIsin && (!joinIsin || joinIsin !== rowIsin)) return null;

  return nome;
}

export function resolveNomeExibicaoFromPosicao(
  row: PosicaoCarteiraRow,
  nomesMap: Record<string, string> | Map<string, string> = {},
): string | null {
  const section = (row.section || "cotas").toLowerCase();
  const ativoJoin = row.ativos;

  const cnpjAtivo =
    section === "cotas"
      ? row.cnpjfundo ?? null
      : section === "participacoes"
        ? row.cnpjpart || row.cnpjemissor || null
        : row.cnpjemissor || row.cnpjemp || row.cnpjfundo || null;

  const isinKey = isinUtilizavel(row.isin);
  const joinNome = ativoJoinNomeConfiavel(isinKey, ativoJoin);

  let nomeExibicao: string | null = null;

  if (section === "imoveis") {
    nomeExibicao =
      joinNome ||
      row.nomecomercial?.trim() ||
      (row.logradouro
        ? `${row.logradouro}${row.numero ? `, ${row.numero}` : ""}`
        : null);
  } else if (section === "participacoes") {
    if (!ativoJoin?.tipo_ativo || ativoJoin.tipo_ativo === "PARTICIPACAO") {
      nomeExibicao = joinNome || row.nomecomercial?.trim() || null;
    }
  } else if (
    section === "titpublico" ||
    section === "titprivado" ||
    section === "termorf" ||
    section === "acoes"
  ) {
    nomeExibicao = joinNome || row.codativo?.trim() || row.isin?.trim() || null;
  }

  if (!nomeExibicao) {
    nomeExibicao = resolveNomeFromLookupMap(cnpjAtivo, row.isin, nomesMap) || joinNome;
  }

  return nomeExibicao;
}

export const fmtCnpj = (cnpj: string): string => {
  const clean = cnpj.replace(/\D/g, "");
  if (clean.length !== 14) return cnpj;
  return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
};

export function mapPosicaoToAtivo(
  row: PosicaoCarteiraRow,
  nomesMap: Record<string, string> = {},
): PosicaoAtivo | null {
  if (row.fundo_cnpj == null || row.fundo_dtposicao == null) return null;

  const section = (row.section || "cotas").toLowerCase();
  const cnpjAtivo =
    section === "cotas"
      ? row.cnpjfundo ?? null
      : section === "participacoes"
        ? row.cnpjpart || row.cnpjemissor || null
        : row.cnpjemissor || row.cnpjemp || row.cnpjfundo || null;

  const isinKey = isinUtilizavel(row.isin);
  let nomeExibicao = resolveNomeExibicaoFromPosicao(row, nomesMap);
  if (!nomeExibicao) {
    nomeExibicao = cnpjAtivo ? fmtCnpj(cnpjAtivo) : row.isin ?? row.codativo ?? "—";
  }

  const { qt, pu } = resolvePuQtFromRow(row);
  if (pu == null) return null;

  return {
    fundo_cnpj: row.fundo_cnpj,
    data_posicao: yyyymmddToIso(row.fundo_dtposicao),
    ativo_key: getAtivoKeyFromRow(row),
    section,
    cnpj_ativo: cnpjAtivo,
    isin_ativo: isinKey,
    nome_ativo: row.isin ?? cnpjAtivo ?? row.codativo ?? null,
    nome_exibicao: nomeExibicao,
    qt_disponivel: qt,
    pu_posicao: pu,
  };
}

export function calcPercPL(
  qtDisponivel: number,
  puPosicao: number,
  plFundo: number,
): number | null {
  if (plFundo === 0) return null;
  const vlMercado = qtDisponivel * puPosicao;
  return (vlMercado / plFundo) * 100;
}

export function calcVarPU(
  puHoje: number,
  puOntem: number | null,
): number | null {
  if (puOntem === null || puOntem === 0) return null;
  return (puHoje / puOntem - 1) * 100;
}

export const VAR_PU_MAX_PLAUSIVEL = 3;

export function isVarPuPlausivel(varPu: number | null): boolean {
  if (varPu === null) return false;
  return Math.abs(varPu) <= VAR_PU_MAX_PLAUSIVEL;
}

export function dedupSeriePuPorData(
  rows: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
): Array<{ data_posicao: string; pu_posicao: number }> {
  const byDate = new Map<string, { puSum: number; qtSum: number }>();

  for (const r of rows) {
    if (r.pu_posicao <= 0) continue;
    const qt = r.qt && r.qt > 0 ? r.qt : 1;
    const cur = byDate.get(r.data_posicao) ?? { puSum: 0, qtSum: 0 };
    cur.puSum += r.pu_posicao * qt;
    cur.qtSum += qt;
    byDate.set(r.data_posicao, cur);
  }

  return [...byDate.entries()]
    .map(([data_posicao, { puSum, qtSum }]) => ({
      data_posicao,
      pu_posicao: qtSum > 0 ? puSum / qtSum : 0,
    }))
    .filter((x) => x.pu_posicao > 0)
    .sort((a, b) => a.data_posicao.localeCompare(b.data_posicao));
}

export function calcVarPUAtivo(
  posicoesDoAtivo: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
  dataRef: string,
): number | null {
  const serie = dedupSeriePuPorData(posicoesDoAtivo);
  const hoje = serie.find((p) => p.data_posicao === dataRef);
  const ontem = [...serie]
    .filter((p) => p.data_posicao < dataRef)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  if (!hoje || !ontem || ontem.pu_posicao === 0) return null;
  return calcVarPU(hoje.pu_posicao, ontem.pu_posicao);
}

export function encontrarPontoSerieMaisProximo<T extends { data_posicao: string }>(
  serie: T[],
  alvo: Date,
  janelaMaxDias = 30,
): T | null {
  const alvoMs = alvo.getTime();
  let melhor: T | null = null;
  let menorDiff = Infinity;

  for (const s of serie) {
    const diff = Math.abs(
      new Date(s.data_posicao + "T12:00:00").getTime() - alvoMs,
    );
    const diffDias = diff / (1000 * 60 * 60 * 24);
    if (diffDias <= janelaMaxDias && diffDias < menorDiff) {
      menorDiff = diffDias;
      melhor = s;
    }
  }
  return melhor;
}

export function calcVarPUMes(
  posicoesDoAtivo: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
  dataRef: string,
): number | null {
  const inicioMes = `${dataRef.slice(0, 7)}-01`;
  const serie = dedupSeriePuPorData(posicoesDoAtivo);
  const base = [...serie]
    .filter((p) => p.data_posicao < inicioMes)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  const hoje = serie.find((p) => p.data_posicao === dataRef);
  if (!base || !hoje || base.pu_posicao === 0) return null;
  return calcVarPU(hoje.pu_posicao, base.pu_posicao);
}

export function calcVarPUAno(
  posicoesDoAtivo: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
  dataRef: string,
): number | null {
  const inicioAno = `${dataRef.slice(0, 4)}-01-01`;
  const serie = dedupSeriePuPorData(posicoesDoAtivo);
  const base = [...serie]
    .filter((p) => p.data_posicao < inicioAno)
    .sort((a, b) => b.data_posicao.localeCompare(a.data_posicao))[0];
  const hoje = serie.find((p) => p.data_posicao === dataRef);
  if (!base || !hoje || base.pu_posicao === 0) return null;
  return calcVarPU(hoje.pu_posicao, base.pu_posicao);
}

export function calcVarPU12M(
  posicoesDoAtivo: Array<{
    data_posicao: string;
    pu_posicao: number;
    qt?: number;
  }>,
  dataRef: string,
): number | null {
  const serie = dedupSeriePuPorData(posicoesDoAtivo);
  const alvo = new Date(dataRef + "T12:00:00");
  alvo.setFullYear(alvo.getFullYear() - 1);
  const base = encontrarPontoSerieMaisProximo(serie, alvo);
  const hoje = serie.find((p) => p.data_posicao === dataRef);
  if (!base || !hoje || base.pu_posicao === 0) return null;
  return calcVarPU(hoje.pu_posicao, base.pu_posicao);
}

function normalizeNomeFundo(nome: string | null | undefined): string {
  return (nome ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function cnpjTemClasseUnica(
  rows: PosicaoCarteiraRow[],
  fundoCnpj: string,
): boolean {
  const isins = new Set<string>();
  for (const r of rows) {
    if (r.fundo_cnpj !== fundoCnpj) continue;
    const isin = r.fundo_isin?.trim().toUpperCase();
    if (isin) isins.add(isin);
  }
  return isins.size <= 1;
}

export function isRowFromSelectedClasse(
  row: PosicaoCarteiraRow,
  fundoIsin: string | null,
  fundoNome: string | null,
  classeUnica = false,
): boolean {
  const rowIsin = row.fundo_isin?.trim().toUpperCase() ?? null;
  const selectedIsin = fundoIsin?.trim().toUpperCase() ?? null;
  const rowNome = normalizeNomeFundo(row.nome_fundo ?? row.fundo_nome ?? null);
  const selectedNome = normalizeNomeFundo(fundoNome);

  if (selectedIsin) {
    if (rowIsin === selectedIsin) return true;
    if (!rowIsin && classeUnica) return true;
    return false;
  }

  if (selectedNome) return rowNome === selectedNome;

  return true;
}

export function agregarAtivosPorChave(ativos: PosicaoAtivo[]): PosicaoAtivo[] {
  const map = new Map<
    string,
    PosicaoAtivo & { _qtAcum: number; _puPonderado: number }
  >();

  for (const a of ativos) {
    const key = a.ativo_key;
    const qt = a.qt_disponivel ?? 0;
    const pu = a.pu_posicao ?? 0;
    const existente = map.get(key);

    if (!existente) {
      map.set(key, {
        ...a,
        _qtAcum: qt,
        _puPonderado: pu * qt,
      });
      continue;
    }

    existente._qtAcum += qt;
    existente._puPonderado += pu * qt;
    existente.qt_disponivel = existente._qtAcum;
    existente.pu_posicao =
      existente._qtAcum > 0
        ? existente._puPonderado / existente._qtAcum
        : existente.pu_posicao;
  }

  const agregados = [...map.values()].map(({ _qtAcum, _puPonderado, ...a }) => a);
  return deduplicarCotasPorCnpj(agregados);
}
