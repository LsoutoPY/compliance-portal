/**
 * Formatação de rótulos legíveis para nós do Mapa de Fundos.
 * Nunca exibe código pelado (ex.: "760199") sem contexto de tipo.
 */

import { normalizeCnpjDigits } from "@/lib/fundosMonitorados";
import { supabase } from "@/integrations/supabase/client";
import { buildFundoDisplayKey } from "./keys";

const NOMES_CADASTRO_BATCH = 80;

const ESTRUTURA_NOME_CANONICO = new Set(["", "Classe", "Fundo"]);

export interface FundoCaracteristicaNomeRow {
  cnpj_classe: string | null;
  cnpj_fundo: string | null;
  nome_comercial: string | null;
  estrutura?: string | null;
}

/**
 * Mapeia cada CNPJ-alvo ao seu nome_comercial sem vazar subclasse para a classe.
 * Ex.: linha CONDOCASH 3 SR (subclasse) não deve renomear o FIDC LC (cnpj_classe compartilhado).
 */
export function buildNomeCadastroPorCnpj(
  rows: FundoCaracteristicaNomeRow[],
  targetCnpjs: string[],
): Map<string, string> {
  const targets = [
    ...new Set(
      targetCnpjs
        .map((c) => normalizeCnpjDigits(c))
        .filter((c) => c.length === 14),
    ),
  ];
  const out = new Map<string, string>();

  for (const cnpj of targets) {
    const candidates = rows.filter((r) => {
      const cc = normalizeCnpjDigits(r.cnpj_classe);
      const cf = normalizeCnpjDigits(r.cnpj_fundo);
      return cc === cnpj || cf === cnpj;
    });
    if (!candidates.length) continue;

    const canon = candidates.filter((r) =>
      ESTRUTURA_NOME_CANONICO.has((r.estrutura ?? "").trim()),
    );
    const pool = canon.length ? canon : candidates;

    const byClasse = pool.find((r) => normalizeCnpjDigits(r.cnpj_classe) === cnpj);
    const byFundo = pool.find((r) => normalizeCnpjDigits(r.cnpj_fundo) === cnpj);
    const pick = byClasse ?? byFundo ?? pool[0];
    const nome = pick.nome_comercial?.trim();
    if (nome) out.set(cnpj, nome);
  }

  return out;
}

type AtivoRow = {
  section?: string | null;
  nomecomercial?: string | null;
  codativo?: string | null;
  isin?: string | null;
  cnpjemissor?: string | null;
  cnpjpart?: string | null;
  matricula?: string | null;
  logradouro?: string | null;
  numero?: string | null;
};

const SECTION_PREFIX: Record<string, string> = {
  titpublico: "Tít. Público",
  titprivado: "Tít. Privado",
  caixa: "Caixa",
  participacoes: "Participação",
  acoes: "Ação",
  termorf: "Termo RF",
  imoveis: "Imóvel",
  cotas: "Cota",
};

export function labelSection(section: string | null | undefined): string {
  return SECTION_PREFIX[section?.toLowerCase() ?? ""] ?? (section || "Ativo");
}

/**
 * Rótulo legível para um ativo terminal.
 * Prioridade: nomecomercial → isin → "SEÇÃO (cód. CÓDIGO)" → fallback de seção.
 * Garante que nunca exibe apenas um código sem contexto.
 */
export function formatNomeAtivo(row: AtivoRow): string {
  const nome = row.nomecomercial?.trim();
  if (nome) return nome;

  const section = row.section?.toLowerCase() ?? "";
  const prefix = SECTION_PREFIX[section] ?? labelSection(section);

  const isin = row.isin?.trim();
  if (isin && !isin.includes("*")) return `${prefix} (${isin})`;

  const cod = row.codativo?.trim();
  if (cod) return `${prefix} (cód. ${cod})`;

  const emis = row.cnpjemissor?.replace(/\D/g, "");
  if (emis) return `${prefix} (CNPJ ${emis})`;

  if (section === "imoveis") {
    const mat = row.matricula?.trim();
    const addr = [row.logradouro, row.numero].filter(Boolean).join(" ");
    if (mat) return `Imóvel (mat. ${mat})`;
    if (addr) return `Imóvel (${addr})`;
  }

  return prefix;
}

/** Nomes legais/genéricos do XML ou ANBIMA — pouco úteis no grafo. */
const NOME_GENERICO_RE =
  /^(única )?classe (de |únic[ao] )?investimento|fundo de investimento em (direitos|cotas|particip)/i;

export function isNomeGenericoFundo(nome: string | null | undefined): boolean {
  if (!nome?.trim()) return true;
  const n = nome.trim();
  const lower = n.toLowerCase();
  if (NOME_GENERICO_RE.test(lower)) return true;
  if (
    n.length > 40 &&
    /classe de investimento|fundo de investimento em/i.test(lower) &&
    !/\bfidc\b|\bfip\b|\bfif\b|\bfii\b/i.test(lower)
  ) {
    return true;
  }
  return false;
}

function scoreNomeFundo(nome: string): number {
  const n = nome.trim();
  if (!n) return -1;
  if (isNomeGenericoFundo(n)) return 1;
  let score = 50;
  score -= Math.min(n.length / 8, 25);
  if (/\b(FIDC|FIP|FIF|FII|FIM|FAC)\b/i.test(n)) score += 15;
  const first = n.split(/\s+/)[0] ?? "";
  if (first.length >= 3 && first.length <= 14 && !/^(FUNDO|CLASSE|ÚNICA|UNICA)$/i.test(first)) {
    score += 10;
  }
  return score;
}

/** Escolhe o rótulo mais legível entre owner, refs de cota e cadastro ANBIMA. */
export function escolherMelhorNomeFundo(
  candidatos: Array<string | null | undefined>,
): string | undefined {
  const unicos = [...new Set(candidatos.map((c) => c?.trim()).filter((c): c is string => !!c))];
  if (!unicos.length) return undefined;
  return [...unicos]
    .map((n) => ({ n, s: scoreNomeFundo(n) }))
    .sort((a, b) => b.s - a.s || a.n.length - b.n.length)[0]?.n;
}

/**
 * Rótulo canônico de fundo.
 * Prioriza nomes do próprio fundo (nome_fundo / fundo_nome na linha do XML)
 * sobre nomes vindos de posições de cota de terceiros (nomecomercial na tranche).
 */
export function melhorNomeFundo(
  ownerNomes: Array<string | null | undefined>,
  refNomes: Array<string | null | undefined>,
  fallback: string,
): string {
  const ownerReal = ownerNomes.some((n) => n?.trim() && !isNomeGenericoFundo(n));
  if (ownerReal) {
    const melhorOwner = escolherMelhorNomeFundo(ownerNomes);
    if (melhorOwner) return melhorOwner;
  }
  return escolherMelhorNomeFundo(refNomes) ?? fallback;
}

/** Busca nome_comercial em fundos_caracteristicas por CNPJ (cadastro ANBIMA). */
export async function fetchNomesFundosCaracteristicas(
  cnpjs: string[],
): Promise<Map<string, string>> {
  const unique = [
    ...new Set(
      cnpjs
        .map((c) => normalizeCnpjDigits(c))
        .filter((c) => c.length === 14),
    ),
  ];
  if (unique.length === 0) return new Map();

  const out = new Map<string, string>();

  for (let i = 0; i < unique.length; i += NOMES_CADASTRO_BATCH) {
    const chunk = unique.slice(i, i + NOMES_CADASTRO_BATCH);
    const formatted = chunk.map((c) =>
      c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"),
    );
    const rows: FundoCaracteristicaNomeRow[] = [];
    for (const coluna of ["cnpj_classe", "cnpj_fundo"] as const) {
      const { data, error } = await supabase
        .from("fundos_caracteristicas" as never)
        .select("cnpj_classe, cnpj_fundo, nome_comercial, estrutura")
        .in(coluna, chunk);
      if (error) {
        console.warn("[mapaFundos] Erro ao buscar nomes ANBIMA:", error.message);
        continue;
      }
      rows.push(...((data ?? []) as FundoCaracteristicaNomeRow[]));
      try {
        const extra = await supabase
          .from("fundos_caracteristicas" as never)
          .select("cnpj_classe, cnpj_fundo, nome_comercial, estrutura")
          .in(coluna, formatted);
        if (!extra.error) rows.push(...((extra.data ?? []) as FundoCaracteristicaNomeRow[]));
      } catch {
        /* máscara com "/" pode falhar no PostgREST */
      }
    }

    const partial = buildNomeCadastroPorCnpj(rows, chunk);
    for (const [k, v] of partial) out.set(k, v);
  }

  return out;
}

/**
 * Rótulo de fundo: XML próprio (owner) > cadastro ANBIMA > referências de cota > CNPJ.
 * Cadastro preenche fundos externos sem XML; não sobrescreve nome do próprio fundo.
 */
function nomeCadastroResolvido(cadastro: string | undefined): string | undefined {
  if (!cadastro?.trim()) return undefined;
  const segmento = escolherSegmentoNomeHifen(cadastro);
  const nome = (segmento || cadastro).trim();
  return nome || undefined;
}

export function chaveNomeReserva(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\b(FICFIF|FICFIDC|FIF|FIDC|FIC|FIM|FII|FIP)\b/g, " ")
    .replace(/\bALVORADA\b/g, "ALVORA")
    .replace(/[^A-Z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nomePertenceAOutroCnpj(
  nome: string | null | undefined,
  cnpj: string,
  donoPorNome?: Map<string, string>,
): boolean {
  if (!nome?.trim() || !donoPorNome?.size) return false;
  const chave = chaveNomeReserva(nome);
  if (chave.length < 4) return false;
  const dono = donoPorNome.get(chave);
  return !!dono && dono !== normalizeCnpjDigits(cnpj);
}

export function donoPorNomeCanonico(
  fundos: Array<{ cnpj: string; ownerNomes?: Array<string | null | undefined>; cadastro?: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const fundo of fundos) {
    const cnpj = normalizeCnpjDigits(fundo.cnpj);
    if (cnpj.length !== 14) continue;
    const candidatos = [
      nomeCadastroResolvido(fundo.cadastro),
      escolherMelhorNomeFundo((fundo.ownerNomes ?? []).filter(n => n?.trim() && !isNomeGenericoFundo(n))),
    ];
    for (const nome of candidatos) {
      const chave = nome ? chaveNomeReserva(nome) : "";
      if (chave.length < 4 || out.has(chave)) continue;
      out.set(chave, cnpj);
    }
  }
  return out;
}

export function nomeFundoComCadastro(
  cnpj: string,
  ownerNomes: Array<string | null | undefined>,
  refNomes: Array<string | null | undefined>,
  cadastroMap: Map<string, string>,
  donoPorNome?: Map<string, string>,
): string {
  const norm = normalizeCnpjDigits(cnpj);
  const cadastro = cadastroMap.get(norm);
  const cadastroNome = nomeCadastroResolvido(cadastro);
  const ownerReal = ownerNomes.some((n) => n?.trim() && !isNomeGenericoFundo(n));

  if (ownerReal) {
    const melhorOwner = escolherMelhorNomeFundo(ownerNomes);
    if (melhorOwner) return melhorOwner;
  }

  // Cadastro ANBIMA por CNPJ tem precedência sobre nomecomercial de cota de terceiros
  // (ex.: cota rotulada "FICFIDC BIAJU" apontando para o fundo ARC DP).
  if (cadastroNome && !isNomeGenericoFundo(cadastroNome)) return cadastroNome;

  const ref = escolherMelhorNomeFundo(refNomes.filter(n => !nomePertenceAOutroCnpj(n, norm, donoPorNome)));
  if (ref) return ref;

  if (cadastroNome) return cadastroNome;
  if (cadastro?.trim()) return cadastro.trim();

  return norm || cnpj;
}

export interface FundoCatalogoNome {
  cnpj: string;
  nome: string;
}

/** Nome exibido no grafo: catálogo do Mapa de Ativos (fundo_nome) > nome do snapshot. */
export function resolveNomeFundoCatalogo(
  cnpj: string | undefined,
  nomeGrafo: string,
  catalogoFundos: FundoCatalogoNome[] = [],
): string {
  if (!cnpj) return nomeGrafo;
  const cnpjNorm = normalizeCnpjDigits(cnpj);
  const catalogo = catalogoFundos.find((f) => normalizeCnpjDigits(f.cnpj) === cnpjNorm);
  return catalogo?.nome?.trim() || nomeGrafo;
}

/**
 * Catálogo de fundos monitorados: ANBIMA por CNPJ > fundo_nome do XML.
 * Homônimos ganham sufixo do CNPJ (ex.: FICFIDC BIAJU·000129).
 */
export function buildCatalogoFundosMapa(
  fundosXml: Array<{ cnpj: string; nome?: string | null }>,
  fundosCarac: FundoCaracteristicaNomeRow[] = [],
): FundoCatalogoNome[] {
  const xmlPorCnpj = new Map<string, string>();
  for (const f of fundosXml) {
    const cnpj = normalizeCnpjDigits(f.cnpj);
    if (cnpj.length !== 14 || xmlPorCnpj.has(cnpj)) continue;
    xmlPorCnpj.set(cnpj, f.nome?.trim() || "");
  }

  const cnpjs = [...xmlPorCnpj.keys()];
  const cadastroNomes = buildNomeCadastroPorCnpj(fundosCarac, cnpjs);

  const base: NoRotulo[] = cnpjs.map((cnpj) => {
    const cadastro = cadastroNomes.get(cnpj);
    const xml = xmlPorCnpj.get(cnpj) || "";
    let nome = cadastro || xml || cnpj;
    if (cadastro) {
      const segmento = escolherSegmentoNomeHifen(cadastro);
      if (segmento && !isNomeGenericoFundo(segmento)) nome = segmento;
      else if (!isNomeGenericoFundo(cadastro)) nome = cadastro;
    }
    return { key: buildFundoDisplayKey(cnpj), cnpj, nome };
  });

  const rotulos = rotulosNoDisambiguados(base, 48);
  return base.map((b) => ({
    cnpj: b.cnpj!,
    nome: rotulos.get(b.key) ?? b.nome,
  }));
}

/** Rótulos disambiguados usando catálogo + todos os fundos do grafo. */
export function buildRotulosFundosDisambiguados(
  nos: Array<{ key: string; cnpj?: string; nome: string }>,
  catalogoFundos: FundoCatalogoNome[] = [],
  maxLen = 22,
): Map<string, string> {
  return rotulosNoDisambiguados(
    nos.map((n) => ({
      key: n.key,
      cnpj: n.cnpj,
      nome: resolveNomeFundoCatalogo(n.cnpj, n.nome, catalogoFundos),
    })),
    maxLen,
  );
}

/** Segmento legível após hífen (ex.: "FIDC PLANNER 2675 - PEDRA AZUL FIDC" → Pedra Azul). */
export function escolherSegmentoNomeHifen(nome: string): string | null {
  const partes = nome
    .split(/\s[-–]\s/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (partes.length < 2) return null;

  const ruidoAdmin = /planner|\bcotas do\b|\b\d{4,}\b/i;
  const limpos = partes.filter((p) => !ruidoAdmin.test(p) && !isNomeGenericoFundo(p));
  if (limpos.length === 1) return limpos[0];
  if (limpos.length > 1) {
    // "FICFIDC BIAJU - ARC DP FIDC" → preferir o segmento após o master/feeder
    const feeder = limpos[0]?.match(/^FIC(?:FIDC|FIC|FIF|FIM|FIP)\s+/i);
    if (feeder && limpos.length >= 2) {
      return escolherMelhorNomeFundo(limpos.slice(1)) ?? limpos[1];
    }
    return escolherMelhorNomeFundo(limpos) ?? limpos[0];
  }

  return escolherMelhorNomeFundo(partes) ?? partes[partes.length - 1];
}

const STOP_TOKENS_ROTULO = new Set([
  "FUNDO",
  "DE",
  "INVESTIMENTO",
  "EM",
  "DIREITOS",
  "CREDITÓRIOS",
  "CRÉDITOS",
  "CLASSE",
  "ÚNICA",
  "UNICA",
  "LIMITADA",
  "RESP",
  "LTDA",
  "NÃO",
  "NAO",
  "PADRONIZADOS",
  "NÃO-PADRONIZADOS",
]);

/** Rótulo curto para o canvas — evita "ÚNICA CLASSE DE INVESTIM…" em L3+. */
export function rotuloExibicaoFundo(nome: string, maxLen = 24): string {
  if (!nome?.trim()) return "—";

  const segmento = escolherSegmentoNomeHifen(nome);
  if (segmento && segmento !== nome.trim()) {
    return truncNome(segmento, maxLen);
  }

  if (isNomeGenericoFundo(nome)) {
    const partes = nome.split(/\s[-–]\s/);
    if (partes.length > 1) {
      const curta = escolherMelhorNomeFundo(partes);
      if (curta && !isNomeGenericoFundo(curta)) return truncNome(curta, maxLen);
    }
  }

  const tokens = nome.trim().split(/\s+/);
  const compact: string[] = [];
  for (const t of tokens) {
    const u = t.toUpperCase().replace(/[^\wÁÀÃÉÍÓÚÇ]/g, "");
    if (compact.length === 0 && STOP_TOKENS_ROTULO.has(u)) continue;
    if (compact.length > 0 && STOP_TOKENS_ROTULO.has(u)) break;
    compact.push(t);
    if (compact.length >= 4) break;
  }
  return truncNome(compact.join(" ") || nome, maxLen);
}

export function formatCnpjDisplay(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "").padStart(14, "0");
  if (d.length !== 14) return cnpj;
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

export function truncNome(nome: string, max = 18): string {
  if (!nome) return "—";
  return nome.length > max ? nome.slice(0, max - 1) + "…" : nome;
}

function normalizarNomeGrafico(nome: string): string {
  return nome.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface NoRotulo {
  key: string;
  nome: string;
  cnpj?: string;
}

/**
 * Fundos/atvos com o mesmo nome (ex.: dois BACO ou dois LC) ganham sufixo do CNPJ
 * para não parecer que o fundo investe "nele mesmo".
 */
export function rotulosNoDisambiguados(
  nos: NoRotulo[],
  maxLen = 22,
): Map<string, string> {
  const porNome = new Map<string, NoRotulo[]>();
  for (const n of nos) {
    const norm = normalizarNomeGrafico(n.nome);
    const list = porNome.get(norm) ?? [];
    list.push(n);
    porNome.set(norm, list);
  }

  const out = new Map<string, string>();
  for (const n of nos) {
    const base = rotuloExibicaoFundo(n.nome, maxLen);
    const homonimos = porNome.get(normalizarNomeGrafico(n.nome)) ?? [];
    if (homonimos.length > 1 && n.cnpj) {
      const sufixo = n.cnpj.replace(/\D/g, "").slice(-6);
      const baseMax = Math.max(8, maxLen - sufixo.length - 1);
      out.set(n.key, `${rotuloExibicaoFundo(n.nome, baseMax)}·${sufixo}`);
    } else {
      out.set(n.key, base);
    }
  }
  return out;
}

export function fmtPct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

/** Formata percentual acumulado (ex.: "12,3% acum.") — painel + nó organograma. */
export function fmtPctAcum(v: number): string {
  return (v * 100).toFixed(1) + "% acum.";
}

/** Formata percentual de passo direto de aresta (ex.: "4,1%"). */
export function fmtPctStep(v: number): string {
  return (v * 100).toFixed(1) + "%";
}
