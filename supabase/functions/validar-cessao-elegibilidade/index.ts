/**
 * Edge Function: validar-cessao-elegibilidade (v3)
 *
 * Motor genérico — consome CESSAO_CONDICAO + CONCENTRACAO_* de regras_compliance + fundo_regras.
 * Cada regra CESSAO_CONDICAO define campo, operador, valor_limite, unidade, modo e filtros.
 *
 * Fluxo:
 *   1. Parse CSV (;-delimited, encoding UTF-8/latin1)
 *   2. Identifica fundo pelo CNPJ_FUNDO
 *   3. Carrega regras do catálogo unificado (fundo_regras + regras_compliance)
 *   4. Carrega carteira atual (estoque_fidc) e PL + data (última posicao_carteira; FIDC: ativos + a receber)
 *   2b. Separa recompras de aquisições (isRecompra: prazo=0, taxa=0, VL iguais, sem chave NFe)
 *   5. Avalia regras individuais por DC → elegível / inelegível (aquisições; recompras via 6.2(f))
 *   6. Simula pró-forma e concentração (estoque + aquisições − recompras) → enquadra / desenquadra
 *   7. Calcula métricas carteira atual / pró-forma
 *   8. Persiste em cessao_importacoes + cessao_resultado_analitico (aquisições + recompras)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const BATCH = 500;

// ── Helpers ─────────────────────────────────────────────────────────────────

function decodeBytes(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (utf8.includes('\uFFFD')) {
    return new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes);
  }
  return utf8;
}

function parseNumberBR(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  let s = String(v).trim();
  if (!s) return 0;
  s = s.replace(/\s/g, '');
  if (s.includes('.') && s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseDateBR(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const br = s.match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  return null;
}

function cleanDoc(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

function isFundoFidcNivel1(nivel1: string | null | undefined): boolean {
  const u = String(nivel1 ?? '').toUpperCase().replace(/\s/g, '');
  return u === 'FIDC' || u === 'FIDCNP';
}

/** Sufixos comuns de subclasse/série usados para não misturar classes (ex.: NEXUM JR × NEXUM SR). */
const CLASSE_SUFFIX_ALIASES: Record<string, string> = {
  SENIOR: 'SR',
  SUBORDINADA: 'SUB',
  SUB: 'SUB',
  MEZANINO: 'MEZ',
  MEZ: 'MEZ',
  UNICA: 'UNICA',
  JR: 'JR',
  SR: 'SR',
  CP: 'CP',
  LP: 'LP',
};

function normalizeNome(nome: string): string {
  return nome
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Extrai o sufixo de subclasse (JR/SR/SUB/MEZ/CP/LP/UNICA) do nome do fundo, se houver. */
function extractClasseSuffix(nome: string): string | null {
  const tokens = normalizeNome(nome).split(' ').filter(Boolean);
  for (const t of tokens) {
    if (CLASSE_SUFFIX_ALIASES[t]) return CLASSE_SUFFIX_ALIASES[t];
  }
  return null;
}

/**
 * Seleciona o registro mais adequado de fundos_caracteristicas quando o mesmo CNPJ
 * possui múltiplas classes (ex: NEXUM JR, NEXUM SR, MOVVIME…).
 * Prioridade: 1) ISIN exato (único por subclasse); 2) nome_comercial exato;
 * 3) melhor match parcial — respeitando o sufixo de classe (JR/SR/…) quando presente,
 *    escolhendo o nome_comercial mais específico (mais longo) entre os candidatos;
 * 4) primeiro registro (último recurso).
 */
function pickBestFundChar<T extends { nome_comercial?: string | null; isin?: string | null }>(
  rows: T[] | null | undefined,
  fundoIsin?: string | null,
  nomeFundo?: string | null,
): T | null {
  if (!rows || rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  if (fundoIsin) {
    const upper = fundoIsin.toUpperCase().trim();
    const byIsin = rows.find(r => String(r.isin ?? '').toUpperCase().trim() === upper);
    if (byIsin) return byIsin;
  }
  if (nomeFundo) {
    const upper = normalizeNome(nomeFundo);
    const byName = rows.find(r => normalizeNome(String(r.nome_comercial ?? '')) === upper);
    if (byName) return byName;

    const candidates = rows
      .map(r => ({ row: r, nc: normalizeNome(String(r.nome_comercial ?? '')) }))
      .filter(({ nc }) => nc.length > 0 && (nc.includes(upper) || upper.includes(nc)));

    if (candidates.length > 0) {
      const csvSuffix = extractClasseSuffix(nomeFundo);
      if (csvSuffix) {
        // Prioriza candidatos cujo sufixo de classe bate com o do CSV — nunca mistura JR×SR.
        const bySuffix = candidates.filter(({ nc }) => extractClasseSuffix(nc) === csvSuffix);
        if (bySuffix.length > 0) {
          bySuffix.sort((a, b) => b.nc.length - a.nc.length);
          return bySuffix[0].row;
        }
        // Sem match de sufixo: descarta candidatos com sufixo CONFLITANTE (ex.: CSV=JR, candidato=SR).
        const semConflito = candidates.filter(({ nc }) => {
          const s = extractClasseSuffix(nc);
          return s == null || s === csvSuffix;
        });
        if (semConflito.length > 0) {
          semConflito.sort((a, b) => b.nc.length - a.nc.length);
          return semConflito[0].row;
        }
      }
      // Sem sufixo no CSV: fica com o nome_comercial mais específico (mais longo).
      candidates.sort((a, b) => b.nc.length - a.nc.length);
      return candidates[0].row;
    }
  }
  return rows[0];
}

/**
 * Conta quantas regras ATIVAS (fundo_regras) cada ISIN do CNPJ possui.
 *
 * Este é o sinal mais confiável para desambiguar subclasses homônimas (ex.: NEXUM
 * JR/SR): reflete a configuração de compliance efetivamente cadastrada pela equipe
 * para aquela classe — diferente de `pl_formula` ou `nome_comercial`, que podem ser
 * idênticos entre as classes de um mesmo fundo.
 */
async function countActiveFundoRegrasByIsin(
  fundoCnpj: string,
  isins: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (isins.length === 0) return counts;
  const { data } = await supabase
    .from('fundo_regras')
    .select('fundo_isin')
    .eq('fundo_cnpj', fundoCnpj)
    .eq('ativo', true)
    .eq('status_aprovacao', 'ativo')
    .in('fundo_isin', isins);
  for (const row of (data ?? []) as { fundo_isin?: string | null }[]) {
    const isin = String(row.fundo_isin ?? '').trim();
    if (!isin) continue;
    counts.set(isin, (counts.get(isin) ?? 0) + 1);
  }
  return counts;
}

/**
 * Resolve ISIN da subclasse a partir do CNPJ + NM_FUNDO do CSV.
 *
 * Fundos como o NEXUM (JR/SR) compartilham o MESMO CNPJ e o NM_FUNDO do CSV do
 * portal de cessão traz a razão social completa do fundo (ex.: "NEXUM FUNDO DE
 * INVESTIMENTO EM DIREITOS CREDITÓRIOS"), NUNCA o nome da subclasse — então o
 * nome do CSV jamais distingue JR de SR. `pl_formula` também não serve de
 * desempate sozinho: no NEXUM, JR e SR estão ambos configurados como 'va_vr'.
 * Por isso a resolução NUNCA deve decidir "no escuro" entre classes homônimas.
 *
 * Ordem de prioridade:
 *   1. Match EXATO de nome_fundo em posicao_carteira, mas só é aceito quando há um único
 *      ISIN distinto na data mais recente — se duas classes têm nome idêntico, isso é
 *      tratado como ambíguo (não escolhe nenhuma arbitrariamente).
 *   2. Caso ambíguo (ou sem match no passo 1): desempata pela subclasse com mais
 *      `fundo_regras` ATIVAS cadastradas — é o sinal de configuração de negócio mais
 *      confiável de qual classe é efetivamente operada para cessão/compliance.
 *   3. Se nenhuma subclasse tem fundo_regras configuradas: desempata via
 *      `fundos_caracteristicas.pl_formula` quando exatamente uma classe usa 'va_vr'.
 *   4. Fallback fuzzy via fundos_caracteristicas.nome_comercial (pickBestFundChar já
 *      distingue sufixo de classe JR/SR/SUB/… quando presente no nome).
 */
async function resolveFundoIsinFromCsv(
  fundoCnpj: string,
  fundoNome?: string | null,
): Promise<string> {
  const cleanCnpj = fundoCnpj.replace(/\D/g, '');
  const nomeCsv = fundoNome?.trim() || null;

  // 1) Nome exato em posicao_carteira — só resolve se for inequívoco (1 único ISIN na data mais recente).
  if (nomeCsv) {
    const { data: rowsPorNome } = await supabase
      .from('posicao_carteira')
      .select('fundo_isin, fundo_dtposicao')
      .eq('fundo_cnpj', fundoCnpj)
      .eq('nome_fundo', nomeCsv)
      .order('fundo_dtposicao', { ascending: false })
      .limit(50);
    const rows: { fundo_isin?: string | null; fundo_dtposicao?: string | null }[] = rowsPorNome ?? [];
    if (rows.length > 0) {
      const maxDate = rows[0].fundo_dtposicao;
      const isinsNaData = new Set(
        rows
          .filter((r) => r.fundo_dtposicao === maxDate)
          .map((r) => String(r.fundo_isin ?? '').trim()),
      );
      if (isinsNaData.size === 1) {
        const unico = [...isinsNaData][0];
        if (unico) return unico;
      } else if (isinsNaData.size > 1) {
        console.warn(
          `[validar-cessao] nome_fundo "${nomeCsv}" ambíguo (${isinsNaData.size} ISINs na mesma data) — ` +
          `desambiguando via fundo_regras/pl_formula/nome_comercial.`,
        );
      }
    }
  }

  const fundCharRows = await fetchAllFundCharacteristics(cleanCnpj);
  const comIsin = fundCharRows.filter(r => r.isin);

  // 2) Desambiguação pela subclasse com mais fundo_regras ATIVAS configuradas.
  if (comIsin.length > 1) {
    const isins = comIsin.map(r => String(r.isin).trim());
    const regrasCount = await countActiveFundoRegrasByIsin(fundoCnpj, isins);
    const comRegras = isins.filter(isin => (regrasCount.get(isin) ?? 0) > 0);
    if (comRegras.length === 1) {
      return comRegras[0];
    }
    if (comRegras.length > 1) {
      comRegras.sort((a, b) => (regrasCount.get(b) ?? 0) - (regrasCount.get(a) ?? 0));
      console.warn(
        `[validar-cessao] CNPJ ${fundoCnpj}: múltiplas subclasses com fundo_regras ativas — ` +
        `usando a de maior número de regras (${comRegras[0]}).`,
      );
      return comRegras[0];
    }

    // 3) Sem fundo_regras em nenhuma subclasse: desempata via pl_formula='va_vr' (se única).
    const vaVrRows = comIsin.filter(r => r.pl_formula === 'va_vr');
    if (vaVrRows.length === 1) {
      return String(vaVrRows[0].isin).trim();
    }
  }

  // 4) Fallback fuzzy por nome_comercial (melhor esforço).
  const fundCharHint = pickBestFundChar(fundCharRows, null, nomeCsv);
  const isin = fundCharHint?.isin ? String(fundCharHint.isin).trim() : '';

  if (isin) {
    const { data } = await supabase
      .from('posicao_carteira')
      .select('fundo_isin')
      .eq('fundo_cnpj', fundoCnpj)
      .eq('fundo_isin', isin)
      .order('fundo_dtposicao', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.fundo_isin) return String(data.fundo_isin).trim();
  }

  return isin;
}

const FUND_REGRAS_CESSAO_SELECT = `
  id, fundo_cnpj, fundo_isin, regra_id, ativo,
  regras_compliance (id, codigo, descricao, parametros)
`;

/** Códigos de motivo do motor — nunca devem ser cadastrados como codigo em regras_compliance. */
const CODIGO_MOTIVO_INTERNO = /^(CADASTRO_|LIMITE_COMITE_EXCEDIDO$)/;

const DESCRICAO_CADASTRO_PARTES =
  'Cadastro de partes — vigência de cedentes/sacados e limite de comitê';

function descricaoRegraCadastroPartes(descricao: string | null | undefined): string {
  const d = (descricao ?? '').trim();
  if (!d || /investidor profissional|% do pl/i.test(d)) return DESCRICAO_CADASTRO_PARTES;
  return d;
}

function isCodigoMotivoInterno(codigo: string): boolean {
  return CODIGO_MOTIVO_INTERNO.test(codigo);
}

function aggregateCadastroMotivos(
  motivosSummary: Map<string, { regra_codigo: string; regra_descricao: string; count: number }>,
  regraDetalhes: Map<string, { valor_atual: string | null; valor_limite: string | null; dcs: unknown[] }>,
) {
  const submotivos: { codigo: string; descricao: string; count: number }[] = [];
  const dcs: unknown[] = [];
  let valorAtual: string | null = null;
  let valorLimite: string | null = null;

  for (const [cod, val] of motivosSummary) {
    if (!cod.startsWith('CADASTRO_') && cod !== 'LIMITE_COMITE_EXCEDIDO') continue;
    submotivos.push({ codigo: cod, descricao: val.regra_descricao, count: val.count });
    const det = regraDetalhes.get(cod);
    if (det) {
      dcs.push(...det.dcs);
      if (valorAtual == null && det.valor_atual != null) valorAtual = det.valor_atual;
      if (valorLimite == null && det.valor_limite != null) valorLimite = det.valor_limite;
    }
  }

  submotivos.sort((a, b) => b.count - a.count);
  return { submotivos, dcs, valorAtual, valorLimite };
}

function parseCessaoRulesFromFundoRegras(fundRulesResolved: unknown[]): RuleFromDb[] {
  const rules: RuleFromDb[] = [];
  for (const fr of fundRulesResolved as any[]) {
    const rc = Array.isArray(fr.regras_compliance) ? fr.regras_compliance[0] : fr.regras_compliance;
    if (!rc) continue;
    if (isCodigoMotivoInterno(String(rc.codigo ?? ''))) {
      console.warn(
        `[validar-cessao] Regra ignorada no checklist: codigo "${rc.codigo}" é motivo interno do motor (corrija em Regras de Compliance).`,
      );
      continue;
    }
    const params = (rc.parametros || {}) as Record<string, unknown>;
    const tipoRegra = (params.tipo_regra as string) || '';
    if (tipoRegra === 'CESSAO_CONDICAO' || tipoRegra === 'CESSAO_CADASTRO_PARTES' || tipoRegra.startsWith('CONCENTRACAO_')) {
      rules.push({
        tipo_regra: tipoRegra,
        codigo: rc.codigo,
        descricao: rc.descricao,
        parametros: params,
      });
    }
  }
  return rules;
}

async function loadCessaoRulesForFundo(
  fundoCnpj: string,
  fundoIsin: string,
): Promise<{ rules: RuleFromDb[]; fundoIsinUsado: string }> {
  let isinUsado = fundoIsin;

  const queryFundRegras = async (queryIsins: string[]) => {
    const { data, error } = await supabase
      .from('fundo_regras')
      .select(FUND_REGRAS_CESSAO_SELECT)
      .eq('fundo_cnpj', fundoCnpj)
      .in('fundo_isin', queryIsins)
      .eq('ativo', true)
      .eq('status_aprovacao', 'ativo');
    if (error) throw new Error(`Erro ao carregar regras: ${error.message}`);
    return data ?? [];
  };

  let fundRulesRaw = await queryFundRegras(fundoRegrasIsinQueryValues(fundoIsin));
  let rules = parseCessaoRulesFromFundoRegras(resolveFundoRegrasForIsin(fundRulesRaw, fundoIsin));

  if (rules.length === 0) {
    const { data: allRaw, error: allError } = await supabase
      .from('fundo_regras')
      .select(FUND_REGRAS_CESSAO_SELECT)
      .eq('fundo_cnpj', fundoCnpj)
      .eq('ativo', true)
      .eq('status_aprovacao', 'ativo');
    if (allError) throw new Error(`Erro ao carregar regras: ${allError.message}`);

    rules = parseCessaoRulesFromFundoRegras(resolveFundoRegrasForIsin(allRaw, fundoIsin));

    if (rules.length === 0 && allRaw && allRaw.length > 0) {
      const isinsWithAssoc = [...new Set(
        allRaw.map((r: { fundo_isin?: string | null }) => String(r.fundo_isin ?? '').trim()).filter(Boolean),
      )];
      for (const candidate of isinsWithAssoc) {
        const candidateRules = parseCessaoRulesFromFundoRegras(
          resolveFundoRegrasForIsin(allRaw, candidate),
        );
        if (candidateRules.length > 0) {
          rules = candidateRules;
          isinUsado = candidate;
          console.warn(
            `[validar-cessao] Regras resolvidas via fallback ISIN ${candidate} (CSV resolveu: ${fundoIsin || '—'})`,
          );
          break;
        }
      }
    }
  }

  return { rules, fundoIsinUsado: isinUsado };
}

function fundoRegrasIsinQueryValues(fundoIsin?: string | null): string[] {
  const isin = fundoIsin ?? '';
  return isin ? [isin, ''] : [''];
}

function resolveFundoRegrasForIsin<T extends { fundo_isin?: string | null; regra_id: string }>(
  rows: T[] | null | undefined,
  fundoIsin?: string | null,
): T[] {
  const isin = fundoIsin ?? '';
  const applicable = (rows ?? []).filter((r) => {
    const rowIsin = r.fundo_isin ?? '';
    return rowIsin === '' || rowIsin === isin;
  });
  const byRegra = new Map<string, T>();
  for (const row of applicable) {
    const rowIsin = row.fundo_isin ?? '';
    const existing = byRegra.get(row.regra_id);
    if (!existing) {
      byRegra.set(row.regra_id, row);
      continue;
    }
    if (rowIsin !== '' && (existing.fundo_isin ?? '') === '') {
      byRegra.set(row.regra_id, row);
    }
  }
  return Array.from(byRegra.values());
}

type FundCharRow = {
  nivel1_categoria?: string | null;
  pl_formula?: string | null;
  nome_comercial?: string | null;
  isin?: string | null;
};

/** Todas as linhas de fundos_caracteristicas do CNPJ (todas as classes/subclasses). */
async function fetchAllFundCharacteristics(cleanCnpj: string): Promise<FundCharRow[]> {
  const { data } = await supabase
    .from('fundos_caracteristicas')
    .select('nivel1_categoria, pl_formula, nome_comercial, isin')
    .or(`cnpj_classe.eq.${cleanCnpj},cnpj_fundo.eq.${cleanCnpj}`)
    .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo,estrutura.eq.Subclasse')
    .limit(50);
  return data ?? [];
}

/** Busca características do fundo; prioriza lookup direto por ISIN (subclasses FIDC). */
async function fetchFundCharacteristics(
  cleanCnpj: string,
  fundoIsin?: string | null,
  nomeFundo?: string | null,
): Promise<FundCharRow | null> {
  if (fundoIsin) {
    const { data: byIsin } = await supabase
      .from('fundos_caracteristicas')
      .select('nivel1_categoria, pl_formula, nome_comercial, isin')
      .or(`cnpj_classe.eq.${cleanCnpj},cnpj_fundo.eq.${cleanCnpj}`)
      .eq('isin', fundoIsin)
      .limit(1)
      .maybeSingle();
    if (byIsin) return byIsin;
  }

  const fundCharRows = await fetchAllFundCharacteristics(cleanCnpj);
  return pickBestFundChar(fundCharRows, fundoIsin, nomeFundo);
}

/** PL FIDC no enquadramento/cessão: valorativos (ativos) + valorreceber (a receber). */
function calcPlFidcHeader(valorativos: number, valorreceber: number): number {
  return valorativos + valorreceber;
}

async function resolvePlConsiderado(
  fundoCnpj: string,
  fundoNome?: string | null,
): Promise<{
  pl: number;
  plDataPosicao: string | null;
  plHeaderRaw: number;
  plOrigem: 'xml' | 'fidc_header';
}> {
  const cleanCnpj = fundoCnpj.replace(/\D/g, '');
  const nomeCsv = fundoNome?.trim() || null;
  const isinResolved = await resolveFundoIsinFromCsv(fundoCnpj, nomeCsv);

  const posSelect =
    'fundo_patliq, fundo_dtposicao, fundo_valorativos, fundo_valorreceber, nome_fundo, fundo_isin';

  let plData: {
    fundo_patliq?: number | null;
    fundo_dtposicao?: string | null;
    fundo_valorativos?: number | null;
    fundo_valorreceber?: number | null;
    nome_fundo?: string | null;
    fundo_isin?: string | null;
  } | null = null;

  // 1) Posição filtrada por ISIN (subclasse correta)
  if (isinResolved) {
    const { data } = await supabase
      .from('posicao_carteira')
      .select(posSelect)
      .eq('fundo_cnpj', fundoCnpj)
      .eq('fundo_isin', isinResolved)
      .order('fundo_dtposicao', { ascending: false })
      .limit(1)
      .maybeSingle();
    plData = data;
  }

  // 2) Fallback: filtrar por nome do fundo no CSV
  if (!plData && nomeCsv) {
    const { data } = await supabase
      .from('posicao_carteira')
      .select(posSelect)
      .eq('fundo_cnpj', fundoCnpj)
      .eq('nome_fundo', nomeCsv)
      .order('fundo_dtposicao', { ascending: false })
      .limit(1)
      .maybeSingle();
    plData = data;
  }

  // 3) Fallback legado: última posição do CNPJ (fundos sem subclasses)
  if (!plData) {
    const { data } = await supabase
      .from('posicao_carteira')
      .select(posSelect)
      .eq('fundo_cnpj', fundoCnpj)
      .order('fundo_dtposicao', { ascending: false })
      .limit(1)
      .maybeSingle();
    plData = data;
  }

  const plHeaderRaw = Number(plData?.fundo_patliq) || 0;
  const plDataPosicao =
    plData?.fundo_dtposicao != null && String(plData.fundo_dtposicao).trim() !== ''
      ? String(plData.fundo_dtposicao).trim()
      : null;

  const fundoIsinPosicao = plData?.fundo_isin ?? isinResolved ?? null;
  const nomeFundoPosicao = String(plData?.nome_fundo ?? nomeCsv ?? '').trim() || null;
  const fundChar = await fetchFundCharacteristics(cleanCnpj, fundoIsinPosicao, nomeFundoPosicao);

  const isFidc =
    isFundoFidcNivel1(fundChar?.nivel1_categoria) ||
    (nomeFundoPosicao ?? '').toUpperCase().includes('FIDC');
  // Aplica va+vr SOMENTE quando pl_formula = 'va_vr' (modo Nexum JR).
  const usaVaVr = isFidc && fundChar?.pl_formula === 'va_vr';

  let pl = plHeaderRaw;
  let plOrigem: 'xml' | 'fidc_header' = 'xml';

  if (usaVaVr) {
    const plFidc = calcPlFidcHeader(
      Number(plData?.fundo_valorativos ?? 0) || 0,
      Number(plData?.fundo_valorreceber ?? 0) || 0,
    );
    const plEscolhido = Math.max(plFidc, plHeaderRaw);
    if (plEscolhido > 0) {
      // va_vr corrige PL subdimensionado no XML; se fundo_patliq já for maior, prevalece o XML.
      pl = plEscolhido;
      plOrigem = plFidc > plHeaderRaw ? 'fidc_header' : 'xml';
    }
  }

  return { pl, plDataPosicao, plHeaderRaw, plOrigem };
}

function normalizeHeader(h: string): string {
  return h.toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

interface CsvRow { [key: string]: string }

function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(';').map(h => normalizeHeader(h.trim()));
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(';');
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] ?? '').trim();
    }
    rows.push(row);
  }
  return rows;
}

function getField(row: CsvRow, candidates: string[]): string {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== '') return row[c];
  }
  return '';
}

// ── Interfaces ──────────────────────────────────────────────────────────────

interface RuleFromDb {
  tipo_regra: string;
  codigo: string;
  descricao: string;
  parametros: Record<string, unknown>;
}

interface MotivoRejeicao {
  regra_codigo: string;
  regra_descricao: string;
  valor_atual: number | string | null;
  valor_limite: number | string | null;
  severidade?: 'vedacao' | 'alerta';
}

interface CadastroParteVigente {
  doc_cnpj_cpf: string;
  nome: string | null;
  tipo_parte?: string;
  escopo_limite: 'individual' | 'grupo';
  grupo_chave: string | null;
  limite_operacao: number | null;
  dt_validade: string | null;
  status: 'ativo' | 'suspenso' | 'encerrado';
}

interface CadastroPartesParams {
  verificar_cedente: boolean;
  verificar_sacado: boolean;
  base_calculo: string;
  usar_abatimento_pdd: boolean;
  usar_grupo_economico: boolean;
  politica_nao_cadastrado: 'vedar' | 'alertar';
  politica_cadastro_vencido: 'vedar' | 'alertar';
  politica_revisao_pendente: 'vedar' | 'alertar';
  validade_inclusiva: boolean;
}

function hydrateCadastroPartesParams(raw: Record<string, unknown>): CadastroPartesParams {
  return {
    verificar_cedente: raw.verificar_cedente !== false,
    verificar_sacado: raw.verificar_sacado === true,
    base_calculo: String(raw.base_calculo ?? 'valor_presente'),
    usar_abatimento_pdd: raw.usar_abatimento_pdd !== false,
    usar_grupo_economico: raw.usar_grupo_economico !== false,
    politica_nao_cadastrado: (raw.politica_nao_cadastrado as 'vedar' | 'alertar') ?? 'vedar',
    politica_cadastro_vencido: (raw.politica_cadastro_vencido as 'vedar' | 'alertar') ?? 'vedar',
    politica_revisao_pendente: (raw.politica_revisao_pendente as 'vedar' | 'alertar') ?? 'alertar',
    validade_inclusiva: raw.validade_inclusiva !== false,
  };
}

function isCadastroVencido(dataCessao: string, dtValidade: string | null, inclusiva: boolean): boolean {
  if (!dtValidade) return false;
  return inclusiva ? dataCessao > dtValidade : dataCessao >= dtValidade;
}

function formatBRL(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function motivoCadastroVeto(motivos: MotivoRejeicao[]): boolean {
  return motivos.some(m => m.severidade !== 'alerta');
}

function pushMotivoCadastro(
  motivos: MotivoRejeicao[],
  politica: 'vedar' | 'alertar',
  codigo: string,
  descricao: string,
  valorAtual: string | number | null,
  valorLimite: string | number | null,
) {
  motivos.push({
    regra_codigo: codigo,
    regra_descricao: descricao,
    valor_atual: valorAtual,
    valor_limite: valorLimite,
    severidade: politica === 'alertar' ? 'alerta' : 'vedacao',
  });
}

function avaliarCadastroParte(
  doc: string,
  nome: string,
  tipo: 'cedente' | 'sacado',
  dataCessao: string,
  cadastroMap: Map<string, CadastroParteVigente>,
  params: CadastroPartesParams,
): MotivoRejeicao[] {
  const motivos: MotivoRejeicao[] = [];
  const tipoLabel = tipo === 'cedente' ? 'Cedente' : 'Sacado';
  const cadastro = cadastroMap.get(doc);

  if (!cadastro) {
    pushMotivoCadastro(
      motivos,
      params.politica_nao_cadastrado,
      'CADASTRO_PARTE_INEXISTENTE',
      `${tipoLabel} não cadastrado`,
      nome || doc || '—',
      'cadastro obrigatório',
    );
    return motivos;
  }

  if (cadastro.status === 'suspenso' || cadastro.status === 'encerrado') {
    motivos.push({
      regra_codigo: 'CADASTRO_PARTE_SUSPENSO',
      regra_descricao: `${tipoLabel} com cadastro ${cadastro.status}`,
      valor_atual: cadastro.status,
      valor_limite: 'ativo',
      severidade: 'vedacao',
    });
    return motivos;
  }

  if (!cadastro.dt_validade) {
    pushMotivoCadastro(
      motivos,
      params.politica_revisao_pendente,
      'CADASTRO_REVISAO_PENDENTE',
      'Revisão de cadastro pendente',
      nome || doc,
      'data de validade obrigatória',
    );
  } else if (isCadastroVencido(dataCessao, cadastro.dt_validade, params.validade_inclusiva)) {
    pushMotivoCadastro(
      motivos,
      params.politica_cadastro_vencido,
      'CADASTRO_PARTE_VENCIDO',
      'Cadastro vencido',
      dataCessao,
      cadastro.dt_validade,
    );
  }

  return motivos;
}

async function loadCadastroPartesVigentes(
  fundoCnpj: string,
  fundoIsin: string,
  tipoParte?: 'cedente' | 'sacado',
): Promise<CadastroParteVigente[]> {
  const isins = fundoIsin ? [fundoIsin, ''] : [''];
  let query = supabase
    .from('fidc_cadastro_partes')
    .select('doc_cnpj_cpf, nome, escopo_limite, grupo_chave, limite_operacao, dt_validade, status, tipo_parte')
    .eq('fundo_cnpj', fundoCnpj)
    .eq('vigente', true)
    .in('fundo_isin', isins);
  if (tipoParte) query = query.eq('tipo_parte', tipoParte);
  const { data, error } = await query;
  if (error) {
    console.warn('[validar-cessao] Erro ao carregar cadastro partes:', error.message);
    return [];
  }
  return (data ?? []) as CadastroParteVigente[];
}

interface DcParsed {
  nm_fundo: string;
  cnpj_fundo: string;
  nm_cedente: string;
  cpf_cnpj_cedente: string;
  nm_sacado: string;
  nu_cpf_cnpj_sacado: string;
  nm_tipo_recebivel: string;
  ds_seu_numero: string;
  ds_nu_documento: string;
  vl_pago: number;
  vl_nominal: number;
  prazo: number;
  tx_juro: number;
  tx_cessao: number;
  dt_vencimento: string | null;
  dt_entrada: string | null;
  chave_nfe: string;
  total_aquisicao: number;  // TOTAL_AQUISICAO — totalizador do lote do cedente
  total_nominal: number;    // TOTAL_NOMINAL   — totalizador do lote do cedente
  tipo_operacao: 'AQUISICAO' | 'RECOMPRA';
}

interface EstoqueRow {
  nome_sacado: string | null;
  doc_sacado: string | null;
  nome_cedente: string | null;
  doc_cedente: string | null;
  nu_documento: string | null;
  seu_numero: string | null;
  data_vencimento_ajustada: string | null;
  valor_presente: number | null;
  valor_nominal: number | null;
  valor_aquisicao: number | null;
  valor_pdd: number | null;
  valor_pdd_geral: number | null;
  prazo: number | null;
  prazo_atual: number | null;
  coobrigacao: string | null;
  situacao_recebivel: string | null;
  tipo_recebivel: string | null;
}

// ── Motor de Elegibilidade ──────────────────────────────────────────────────

/**
 * Detecta recompra pelo padrão do portal FIDC:
 * prazo = 0, TX_JURO ≈ 0 e CHAVE_NFE vazia/zeros.
 *
 * Usa apenas TX_JURO para taxa zero — o portal costuma repetir a taxa da cessão
 * em TX_CESSAO (ex.: 0,34) mesmo em linhas de recompra, com TX_JURO = 0.
 * VL_PAGO ≈ VL_NOMINAL não é critério (recompra liquida pelo VP corrente).
 */
function isRecompra(dc: DcParsed): boolean {
  const taxaJuro = dc.tx_juro ?? 0;
  const chaveVazia = !dc.chave_nfe || dc.chave_nfe.replace(/[0\s]/g, '') === '';
  return dc.prazo === 0 && taxaJuro < 0.001 && chaveVazia;
}

/**
 * Exposição pró-forma de um cedente/sacado:
 * (estoque existente + aquisições propostas) − recompras do CSV.
 * Nunca negativo (recompra não pode gerar crédito fictício de espaço).
 */
function exposicaoProforma(estoque: number, proposta: number, recompra: number): number {
  return Math.max(0, estoque + proposta - recompra);
}

function normalizarLimite(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n >= 2 ? n / 100 : n;
}

/** CSV pode trazer 43 (% a.a.) ou 0,43 (equivale a 43% a.a.). */
function normalizeTaxaAnualDeclarada(tx: number): number {
  if (!Number.isFinite(tx) || tx <= 0) return 0;
  if (tx < 2) return tx * 100;
  return tx;
}

function normalizarCoobrigacao(valor: string | null | undefined): boolean | null {
  const v = (valor || '').toString().toUpperCase().trim();
  if (['SIM', 'S', 'COM', 'TRUE', '1', 'YES', 'COM COOBRIGAÇÃO', 'COM COOBRIGACAO'].includes(v)) return true;
  if (['NÃO', 'NAO', 'N', 'SEM', 'FALSE', '0', 'NO', 'SEM COOBRIGAÇÃO', 'SEM COOBRIGACAO'].includes(v)) return false;
  return null;
}

function getExposicao(row: EstoqueRow, baseCalculo: string): number {
  switch (baseCalculo) {
    case 'valor_nominal': return Number(row.valor_nominal) || 0;
    case 'valor_aquisicao': return Number(row.valor_aquisicao) || 0;
    default: return Number(row.valor_presente) || 0;
  }
}

// ── Grupo Econômico ──────────────────────────────────────────────────────────

interface GrupoEconomicoEntry { grupo_id: string; grupo_nome: string }
type GrupoEconomicoMap = Map<string, GrupoEconomicoEntry>;

/**
 * Carrega a tabela grupos_economicos_cnpj (apenas ativos) e devolve
 * um Map cnpj(14d) → { grupo_id, grupo_nome }.
 * Falha silenciosamente (retorna Map vazio) para não bloquear a validação.
 */
async function carregarGruposEconomicos(): Promise<GrupoEconomicoMap> {
  const map: GrupoEconomicoMap = new Map();
  try {
    const { data, error } = await supabase
      .from('grupos_economicos_cnpj')
      .select('cnpj, grupo_id, grupo_nome')
      .eq('ativo', true);
    if (error) {
      console.warn('[validar-cessao] Aviso ao carregar grupos econômicos:', error.message);
      return map;
    }
    for (const row of (data || []) as any[]) {
      const cnpj = cleanDoc(row.cnpj);
      if (cnpj) map.set(cnpj, { grupo_id: row.grupo_id, grupo_nome: row.grupo_nome });
    }
  } catch (err) {
    console.warn('[validar-cessao] Erro inesperado ao carregar grupos econômicos:', err);
  }
  return map;
}

/**
 * Resolve a chave de agrupamento de concentração para um CNPJ:
 * - Se o CNPJ estiver mapeado em grupoMap, usa grupo_id como chave e grupo_nome como nome.
 * - Caso contrário, usa o próprio CNPJ como chave.
 */
function resolverGrupo(
  doc: string | null | undefined,
  nome: string | null | undefined,
  grupoMap: GrupoEconomicoMap,
): { chave: string; nomeGrupo: string; isGrupo: boolean } {
  const cnpj = cleanDoc(doc);
  const entrada = cnpj ? grupoMap.get(cnpj) : undefined;
  if (entrada) return { chave: entrada.grupo_id, nomeGrupo: entrada.grupo_nome, isGrupo: true };
  return {
    chave: cnpj || (nome ?? '').trim() || 'sem_doc',
    nomeGrupo: (nome ?? '').trim() || cnpj || 'Sem identificação',
    isGrupo: false,
  };
}

// ── CDI Spot — BCB SGS série 12 ─────────────────────────────────────────────

/**
 * Busca a taxa DI overnight mais recente na API pública do BCB (SGS série 12)
 * e converte para % a.a. base 252 dias úteis.
 *
 * Endpoint: últimos 5 registros para cobrir fins de semana / feriados.
 * Conversão: cdi_aa = ((1 + taxa_dia/100)^252 - 1) × 100
 */
async function fetchCdiSpotAa(): Promise<{ valor: number | null; fonte: string; erro?: string }> {
  const fonte = 'BCB SGS 12 (automático)';
  try {
    const url = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados/ultimos/5?formato=json';
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      return { valor: null, fonte, erro: `BCB SGS retornou HTTP ${resp.status}` };
    }
    const json = await resp.json() as { data: string; valor: string }[];
    if (!json || json.length === 0) {
      return { valor: null, fonte, erro: 'BCB SGS: nenhum dado retornado' };
    }
    // Pega a taxa do último registro disponível (taxa diária em %)
    const taxaDia = parseFloat(json[json.length - 1].valor);
    if (isNaN(taxaDia) || taxaDia <= 0) {
      return { valor: null, fonte, erro: `BCB SGS: taxa inválida (${json[json.length - 1].valor})` };
    }
    // Converte taxa diária para anual base 252 du
    const cdiAa = (Math.pow(1 + taxaDia / 100, 252) - 1) * 100;
    return { valor: Number(cdiAa.toFixed(4)), fonte };
  } catch (e) {
    return { valor: null, fonte, erro: String(e) };
  }
}

/**
 * Resolve qual CDI usar nas regras de cessão:
 * - Prioritiza o CDI spot buscado automaticamente da BCB.
 * - Fallback para cdi_vigente_aa salvo manualmente na regra (retrocompatibilidade).
 */
function resolveCdi(p: Record<string, unknown>, cdiSpot: number | null): number {
  if (cdiSpot != null && cdiSpot > 0) return cdiSpot;
  return Number(p.cdi_vigente_aa) || 0;
}

// ── Handler ─────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Content-Type deve ser multipart/form-data.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const formData = await req.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhum arquivo recebido no campo "file".' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Mapa de coobrigação por cedente (CNPJ sem máscara → boolean)
    // true = COM coobrigação, false = SEM coobrigação
    // default = true (com coobrigação, conservador: não conta como sem coob)
    const coobrigacaoRaw = formData.get('coobrigacao_cedentes');
    const coobrigacaoCedentes: Record<string, boolean> = coobrigacaoRaw
      ? JSON.parse(coobrigacaoRaw as string)
      : {};

    // ── 1. Parse CSV ──────────────────────────────────────────────────
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = decodeBytes(bytes);
    const csvRows = parseCsv(text);

    if (csvRows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'CSV vazio ou sem linhas válidas.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 2. Parse DCs ──────────────────────────────────────────────────
    const dcs: DcParsed[] = csvRows.map(row => ({
      nm_fundo: getField(row, ['NM_FUNDO']),
      cnpj_fundo: getField(row, ['CNPJ_FUNDO']),
      nm_cedente: getField(row, ['NM_CEDENTE']),
      cpf_cnpj_cedente: getField(row, ['CPF_CNPJ_CEDENTE']),
      nm_sacado: getField(row, ['NM_SACADO']),
      nu_cpf_cnpj_sacado: getField(row, ['NU_CPF_CNPJ_SACADO']),
      nm_tipo_recebivel: getField(row, ['NM_TIPO_RECEBIVEL']),
      ds_seu_numero: getField(row, ['DS_SEU_NUMERO']),
      ds_nu_documento: getField(row, ['DS_NU_DOCUMENTO']),
      vl_pago: parseNumberBR(getField(row, ['VL_PAGO'])),
      vl_nominal: parseNumberBR(getField(row, ['VL_NOMINAL'])),
      prazo: parseInt(getField(row, ['PRAZO']) || '0', 10) || 0,
      tx_juro: parseNumberBR(getField(row, ['TX_JURO', 'TX_CESSAO'])),
      tx_cessao: parseNumberBR(getField(row, ['TX_CESSAO'])),
      dt_vencimento: parseDateBR(getField(row, ['DT_VENCIMENTO'])),
      dt_entrada: parseDateBR(getField(row, ['DT_ENTRADA'])),
      chave_nfe: getField(row, ['CHAVE_NFE']),
      total_aquisicao: parseNumberBR(getField(row, ['TOTAL_AQUISICAO'])),
      total_nominal:   parseNumberBR(getField(row, ['TOTAL_NOMINAL'])),
      tipo_operacao: 'AQUISICAO' as const, // será reclassificado abaixo
    }));

    // ── 2b. Separar aquisições de recompras ─────────────────────────
    // O portal FIDC envia aquisições e recompras no mesmo CSV.
    // Recompras são identificadas automaticamente pelo padrão do campo
    // (prazo=0, taxa=0, VL_PAGO≈VL_NOMINAL, CHAVE_NFE vazia/zeros).
    const dcsAquisicao: DcParsed[] = [];
    const dcsRecompra: DcParsed[] = [];
    const _debugRecompra: object[] = [];
    for (const dc of dcs) {
      const chaveClean = dc.chave_nfe ? dc.chave_nfe.replace(/0/g, '') : '';
      const vlDiff = Math.abs(dc.vl_pago - dc.vl_nominal);
      const criPrazo = dc.prazo === 0;
      const criTaxaJ = (dc.tx_juro ?? 0) < 0.001;
      const criChave = !dc.chave_nfe || dc.chave_nfe.replace(/[0\s]/g, '') === '';
      const detected = criPrazo && criTaxaJ && criChave;
      _debugRecompra.push({
        doc: dc.ds_nu_documento,
        prazo: dc.prazo, criPrazo,
        tx_juro: dc.tx_juro, criTaxaJ,
        tx_cessao: dc.tx_cessao,
        vl_pago: dc.vl_pago, vl_nominal: dc.vl_nominal, vlDiff: +vlDiff.toFixed(4),
        chave_nfe: dc.chave_nfe, chaveClean, criChave,
        detected,
      });
      if (detected) {
        dc.tipo_operacao = 'RECOMPRA';
        dcsRecompra.push(dc);
      } else {
        dcsAquisicao.push(dc);
      }
    }

    const fundoCnpj = cleanDoc(dcs[0].cnpj_fundo);
    const fundoNome = dcs[0].nm_fundo;
    const dataCessao = dcs[0].dt_entrada || new Date().toISOString().slice(0, 10);

    if (!fundoCnpj) {
      return new Response(
        JSON.stringify({ success: false, error: 'CNPJ_FUNDO não encontrado no CSV.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`[validar-cessao] Fundo ${fundoCnpj} (${fundoNome}), ${dcs.length} DCs (${dcsAquisicao.length} aquisições, ${dcsRecompra.length} recompras)`);
    console.log('[isRecompra-debug]', JSON.stringify(_debugRecompra));

    const fundoIsinResolvido = await resolveFundoIsinFromCsv(fundoCnpj, fundoNome);
    console.log(`[validar-cessao] ISIN resolvido para regras: ${fundoIsinResolvido || '(não identificado)'}`);

    // ── 3. Carregar regras do catálogo unificado ─────────────────────
    const { rules, fundoIsinUsado } = await loadCessaoRulesForFundo(fundoCnpj, fundoIsinResolvido);

    console.log(`[validar-cessao] ${rules.length} regras aplicáveis carregadas`);

    const cadastroRule = rules.find(r => r.tipo_regra === 'CESSAO_CADASTRO_PARTES');
    const cadastroParams = cadastroRule
      ? hydrateCadastroPartesParams(cadastroRule.parametros)
      : null;
    const cadastroPartes = cadastroRule
      ? await loadCadastroPartesVigentes(fundoCnpj, fundoIsinUsado)
      : [];
    const cadastroMapCedente = new Map(
      cadastroPartes.filter(c => (c as { tipo_parte?: string }).tipo_parte !== 'sacado').map(c => [c.doc_cnpj_cpf, c]),
    );
    const cadastroMapSacado = new Map(
      cadastroPartes.filter(c => (c as { tipo_parte?: string }).tipo_parte === 'sacado').map(c => [c.doc_cnpj_cpf, c]),
    );
    const cadastroMap = cadastroMapCedente;
    const cadastroPartesCedente = cadastroPartes.filter(c => c.tipo_parte !== 'sacado');
    const cadastroGrupoMap = new Map<string, CadastroParteVigente[]>();
    for (const c of cadastroPartesCedente) {
      if (c.escopo_limite === 'grupo' && c.grupo_chave) {
        const list = cadastroGrupoMap.get(c.grupo_chave) ?? [];
        list.push(c);
        cadastroGrupoMap.set(c.grupo_chave, list);
      }
    }
    if (cadastroRule) {
      console.log(`[validar-cessao] Cadastro partes: ${cadastroPartes.length} cedentes vigentes`);
    }

    // ── 4. Carregar carteira atual (estoque_fidc) ─────────────────────
    const { data: latestImports } = await supabase
      .from('importacoes_estoque_fidc')
      .select('id, fund_document, reference_date')
      .in('status', ['success', 'partial_success'])
      .order('reference_date', { ascending: false })
      .limit(100);

    const matchImport = (latestImports || []).find((imp: any) =>
      cleanDoc(imp.fund_document) === fundoCnpj
    ) as any;

    let estoqueRows: EstoqueRow[] = [];
    if (matchImport) {
      const { data } = await supabase
        .from('estoque_fidc')
        .select('nome_sacado, doc_sacado, nome_cedente, doc_cedente, nu_documento, seu_numero, data_vencimento_ajustada, valor_presente, valor_nominal, valor_aquisicao, valor_pdd, valor_pdd_geral, prazo, prazo_atual, coobrigacao, situacao_recebivel, tipo_recebivel')
        .eq('import_id', matchImport.id);
      estoqueRows = (data || []) as EstoqueRow[];
    }

    // Regra 6.2(f): documentos já recomprados em cessões anteriores deste fundo
    const { data: recomprasHistorico } = await supabase
      .from('cessao_resultado_analitico')
      .select('ds_nu_documento, ds_seu_numero, cpf_cnpj_cedente, cessao_importacoes!inner(fundo_cnpj)')
      .eq('cessao_importacoes.fundo_cnpj', fundoCnpj)
      .eq('tipo_operacao', 'RECOMPRA');

    const recompraHistoricoSet = new Set<string>(
      (recomprasHistorico ?? []).flatMap((r: { ds_nu_documento?: string | null; ds_seu_numero?: string | null; cpf_cnpj_cedente?: string | null }) => {
        const ced = cleanDoc(r.cpf_cnpj_cedente);
        const keys: string[] = [];
        if (r.ds_nu_documento?.trim()) keys.push(`${r.ds_nu_documento.trim()}|${ced}`);
        if (r.ds_seu_numero?.trim()) keys.push(`${r.ds_seu_numero.trim()}|${ced}`);
        return keys;
      }),
    );

    console.log(
      `[validar-cessao] Histórico 6.2(f): ${recompraHistoricoSet.size} documentos já recomprados`,
    );

    // Regra 6.2(f): títulos ainda ativos no estoque (recompra exige liquidado/baixado)
    const estoqueAtivoSet = new Set<string>(
      estoqueRows.flatMap((r) => {
        const situacao = (r.situacao_recebivel || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '');
        if (!situacao.includes('ativo')) return [];
        const ced = cleanDoc(r.doc_cedente);
        const keys: string[] = [];
        if (r.nu_documento?.trim()) keys.push(`${r.nu_documento.trim()}|${ced}`);
        if (r.seu_numero?.trim()) keys.push(`${r.seu_numero.trim()}|${ced}`);
        return keys;
      }),
    );

    console.log(
      `[validar-cessao] Estoque 6.2(f): ${estoqueAtivoSet.size} documentos ativos`,
    );

    console.log(`[validar-cessao] Estoque: ${estoqueRows.length} recebíveis`);

    // Métricas da carteira atual
    const carteiraQtd = estoqueRows.length;
    const carteiraVP = estoqueRows.reduce((s, r) => s + (Number(r.valor_presente) || 0), 0);
    const carteiraPDD = estoqueRows.reduce((s, r) => s + (Number(r.valor_pdd_geral) || Number(r.valor_pdd) || 0), 0);
    const carteiraPrazoSoma = estoqueRows.reduce((s, r) => s + (Number(r.prazo) || 0) * (Number(r.valor_presente) || 0), 0);
    const carteiraPrazoMedio = carteiraVP > 0 ? carteiraPrazoSoma / carteiraVP : 0;

    // ── 5. Carregar PL (última posição; FIDC usa valorativos + valorreceber) ──
    const { pl, plDataPosicao, plHeaderRaw, plOrigem } = await resolvePlConsiderado(fundoCnpj, fundoNome);
    console.log(
      `[validar-cessao] PL=${pl} origem=${plOrigem} header_raw=${plHeaderRaw} dt=${plDataPosicao ?? '—'}`,
    );
    const percPlAlocado = pl > 0 ? carteiraVP / pl : 0;

    // ── 5b. Carregar grupos econômicos + CDI spot (paralelo) ──────────
    const [grupoEconomicoMap, cdiSpotResult] = await Promise.all([
      carregarGruposEconomicos(),
      fetchCdiSpotAa(),
    ]);
    const cdiSpotAa: number | null = cdiSpotResult.valor;
    if (cdiSpotResult.erro) {
      console.warn(`[validar-cessao] CDI BCB: ${cdiSpotResult.erro} — usando fallback cdi_vigente_aa das regras`);
    } else {
      console.log(`[validar-cessao] CDI spot BCB: ${cdiSpotAa?.toFixed(4)}% a.a.`);
    }
    console.log(`[validar-cessao] ${grupoEconomicoMap.size} CNPJs mapeados em grupos econômicos`);

    // ── 6. Pré-computar mapas do estoque ─────────────────────────────

    // Exposição por sacado/cedente para regras de concentração e condição de cessão:
    //   base = valor_nominal (face value) — conforme configuração do fundo
    //   fallback para valor_presente se valor_nominal for nulo/zero
    //   bruto = VN sem abatimento de PDD
    //   liquido = VN − PDD
    //
    // Para regras de concentração respeitamos o regulamento:
    //   "toma-se o Devedor/Cedente considerando o inteiro grupo econômico".
    // Por isso mantemos dois pares de maps: por CNPJ individual (retrocompat) e
    // por chave de grupo econômico (usado nas regras de concentração).
    const estoqueBySacado = new Map<string, number>();       // cnpj → VN bruto
    const estoqueByCedente = new Map<string, number>();      // cnpj → VN bruto
    const estoqueBySacadoLiq = new Map<string, number>();    // cnpj → VN líquido
    const estoqueByCedenteLiq = new Map<string, number>();   // cnpj → VN líquido

    // Maps por grupo econômico (chave = grupo_id quando cadastrado, senão próprio cnpj)
    const estoqueBySacadoGrupo = new Map<string, number>();    // chave → VN bruto consolidado
    const estoqueByCedenteGrupo = new Map<string, number>();
    const estoqueBySacadoGrupoLiq = new Map<string, number>(); // chave → VN líquido consolidado
    const estoqueByCedenteGrupoLiq = new Map<string, number>();
    // Nome amigável de cada chave de grupo (para exibição no breakdown)
    const grupoSacadoNome = new Map<string, string>();
    const grupoCedenteNome = new Map<string, string>();

    let estoqueSemCoobrigacaoTotal = 0;

    // Para prazo médio pró-forma: excluir títulos vencidos (prazo_atual < 0)
    // O prazo médio continua ponderado por valor_presente (métrica estrutural)
    let carteiraVPAVencer = 0;
    let carteiraPrazoSomaAVencer = 0;

    // Cedentes inadimplentes e exposição vencida por sacado (para regras CESSAO_*)
    const cedenteInadimplenteDias = new Map<string, number>();
    const sacadoVencidaExposure = new Map<string, Map<number, number>>();

    for (const r of estoqueRows) {
      const sacado = cleanDoc(r.doc_sacado);
      const cedente = cleanDoc(r.doc_cedente);
      // VP continua sendo usado apenas para ponderação de prazo médio
      const vp = Number(r.valor_presente) || 0;
      // VN é a base das regras de concentração e condição de cessão
      const vn = Number(r.valor_nominal) || vp;
      const pdd = Number(r.valor_pdd_geral) || Number(r.valor_pdd) || 0;
      const vnLiq = Math.max(0, vn - pdd);
      const prazoAtual = Number(r.prazo_atual) || 0;

      if (sacado) {
        estoqueBySacado.set(sacado, (estoqueBySacado.get(sacado) ?? 0) + vn);
        estoqueBySacadoLiq.set(sacado, (estoqueBySacadoLiq.get(sacado) ?? 0) + vnLiq);

        const gSacado = resolverGrupo(sacado, r.nome_sacado, grupoEconomicoMap);
        estoqueBySacadoGrupo.set(gSacado.chave, (estoqueBySacadoGrupo.get(gSacado.chave) ?? 0) + vn);
        estoqueBySacadoGrupoLiq.set(gSacado.chave, (estoqueBySacadoGrupoLiq.get(gSacado.chave) ?? 0) + vnLiq);
        if (!grupoSacadoNome.has(gSacado.chave)) grupoSacadoNome.set(gSacado.chave, gSacado.nomeGrupo);
      }
      if (cedente) {
        estoqueByCedente.set(cedente, (estoqueByCedente.get(cedente) ?? 0) + vn);
        estoqueByCedenteLiq.set(cedente, (estoqueByCedenteLiq.get(cedente) ?? 0) + vnLiq);

        const gCedente = resolverGrupo(cedente, r.nome_cedente, grupoEconomicoMap);
        estoqueByCedenteGrupo.set(gCedente.chave, (estoqueByCedenteGrupo.get(gCedente.chave) ?? 0) + vn);
        estoqueByCedenteGrupoLiq.set(gCedente.chave, (estoqueByCedenteGrupoLiq.get(gCedente.chave) ?? 0) + vnLiq);
        if (!grupoCedenteNome.has(gCedente.chave)) grupoCedenteNome.set(gCedente.chave, gCedente.nomeGrupo);
      }

      const coobr = normalizarCoobrigacao(r.coobrigacao);
      if (coobr === false) estoqueSemCoobrigacaoTotal += vnLiq; // sem coob. usa VN líquido

      // Prazo médio ponderado por VP (métrica estrutural — não muda para VN)
      if (prazoAtual >= 0) {
        carteiraVPAVencer += vp;
        carteiraPrazoSomaAVencer += (Number(r.prazo) || 0) * vp;
      }

      // Inadimplência do cedente: prazo_atual negativo = dias de atraso
      if (cedente && prazoAtual < 0) {
        const diasAtraso = Math.abs(prazoAtual);
        const existing = cedenteInadimplenteDias.get(cedente) ?? 0;
        if (diasAtraso > existing) cedenteInadimplenteDias.set(cedente, diasAtraso);
      }

      // Exposição vencida por sacado agrupada por faixa de dias (base VN)
      if (sacado && prazoAtual < 0) {
        const diasVencido = Math.abs(prazoAtual);
        if (!sacadoVencidaExposure.has(sacado)) sacadoVencidaExposure.set(sacado, new Map());
        const faixas = sacadoVencidaExposure.get(sacado)!;
        for (const faixa of [10, 30, 60, 90, 120, 180, 365]) {
          if (diasVencido >= faixa) {
            faixas.set(faixa, (faixas.get(faixa) ?? 0) + vn);
          }
        }
      }
    }

    // ── 7. Pré-computar grupos por cedente (para taxa implícita) ─────
    // TOTAL_AQUISICAO e TOTAL_NOMINAL são totalizadores repetidos em todas as linhas
    // do mesmo cedente. O prazo_max é o maior prazo do lote (para a fórmula FV).
    // Apenas aquisições participam do cálculo de taxa implícita.
    // Passo 1: coleta totalizadores da planilha e prazo máximo
    const cedenteGroup = new Map<string, { total_aquisicao: number; total_nominal: number; prazo_max: number; vp_soma: number; vn_soma: number }>();
    for (const dc of dcsAquisicao) {
      const cedente = cleanDoc(dc.cpf_cnpj_cedente);
      if (!cedente) continue;
      const existing = cedenteGroup.get(cedente);
      if (!existing) {
        cedenteGroup.set(cedente, {
          total_aquisicao: dc.total_aquisicao || 0,
          total_nominal:   dc.total_nominal   || 0,
          prazo_max:       dc.prazo,
          vp_soma:         dc.vl_pago,
          vn_soma:         dc.vl_nominal,
        });
      } else {
        // Mantém o maior valor do totalizador (repetido nas linhas, mas pode variar por arredondamento)
        if (dc.total_aquisicao > existing.total_aquisicao) existing.total_aquisicao = dc.total_aquisicao;
        if (dc.total_nominal   > existing.total_nominal)   existing.total_nominal   = dc.total_nominal;
        if (dc.prazo           > existing.prazo_max)       existing.prazo_max       = dc.prazo;
        existing.vp_soma += dc.vl_pago;
        existing.vn_soma += dc.vl_nominal;
      }
    }
    // Passo 2: fallback — se TOTAL_AQUISICAO/TOTAL_NOMINAL não vieram na planilha, usa somas de VL_PAGO/VL_NOMINAL
    for (const [, grupo] of cedenteGroup) {
      if (grupo.total_aquisicao === 0) grupo.total_aquisicao = grupo.vp_soma;
      if (grupo.total_nominal   === 0) grupo.total_nominal   = grupo.vn_soma;
    }

    // ── 8. Classificar regras ────────────────────────────────────────

    const individualRules = rules.filter(r => {
      if (r.tipo_regra === 'CESSAO_CONDICAO') {
        const modo = (r.parametros.modo as string) || 'individual';
        return modo === 'individual';
      }
      return false;
    });
    const proformaRules = rules.filter(r => {
      if (r.tipo_regra === 'CESSAO_CONDICAO') {
        const modo = (r.parametros.modo as string) || 'individual';
        return modo === 'proforma' || modo === 'concentracao';
      }
      return r.tipo_regra.startsWith('CONCENTRACAO_');
    });

    interface DcResult {
      dc: DcParsed;
      elegivel: boolean | null;
      enquadra: boolean | null;
      motivos: MotivoRejeicao[];
    }

    // Helper: check if DC matches tipo_recebivel filter
    function matchesTipoRecebivel(dc: DcParsed, filtro: unknown): boolean {
      if (!Array.isArray(filtro) || filtro.length === 0) return true;
      const dcTipo = (dc.nm_tipo_recebivel || '').toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      return filtro.some((f: string) => {
        const target = f.toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
        return dcTipo.includes(target) || target.includes(dcTipo);
      });
    }

    // Helper: check if estoque row matches tipo_recebivel filter
    function matchesTipoRecebivelEstoque(row: EstoqueRow, filtro: unknown): boolean {
      if (!Array.isArray(filtro) || filtro.length === 0) return true;
      const rowTipo = (row.tipo_recebivel || '').toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      return filtro.some((f: string) => {
        const target = f.toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
        return rowTipo.includes(target) || target.includes(rowTipo);
      });
    }

    // Helper: compare using operator
    function opCompare(actual: number, op: string, limit: number): boolean {
      switch (op) {
        case '<=': return actual > limit;
        case '<': return actual >= limit;
        case '>=': return actual < limit;
        case '>': return actual <= limit;
        case '==': return actual !== limit;
        case '!=': return actual === limit;
        default: return actual > limit;
      }
    }

    // results contém apenas aquisições; recompras serão adicionadas ao final
    const results: DcResult[] = [];

    // ── 8. Avaliar regras individuais por DC (somente aquisições) ────

    for (const dc of dcsAquisicao) {
      const motivos: MotivoRejeicao[] = [];

      for (const rule of individualRules) {
        const p = rule.parametros;
        const campo = (p.campo as string) || '';
        let operador = (p.operador as string) || '<=';
        const valorLimite = Number(p.valor_limite) || 0;
        const unidade = (p.unidade as string) || 'dias';

        if (!matchesTipoRecebivel(dc, p.filtro_tipo_recebivel)) continue;

        // Regulamento exige taxa MÍNIMA em relação ao CDI — apenas '>=' faz sentido com unidade % CDI.
        if (campo === 'taxa_cessao' && unidade === 'percentual_cdi' && operador !== '>=') {
          console.warn(`[validar-cessao] Regra ${rule.codigo}: operador '${operador}' com % CDI corrigido para '>=' (taxa mínima).`);
          operador = '>=';
        }

        if (campo === 'vencimento') {
          if (dc.dt_vencimento && dc.dt_entrada) {
            const venc = new Date(dc.dt_vencimento).getTime();
            const entrada = new Date(dc.dt_entrada).getTime();
            if (venc < entrada) {
              motivos.push({
                regra_codigo: rule.codigo,
                regra_descricao: rule.descricao,
                valor_atual: dc.dt_vencimento,
                valor_limite: dc.dt_entrada,
              });
            }
          }
        } else if (campo === 'prazo') {
          if (opCompare(dc.prazo, operador, valorLimite)) {
            motivos.push({
              regra_codigo: rule.codigo,
              regra_descricao: rule.descricao,
              valor_atual: `${dc.prazo}d`,
              valor_limite: `${valorLimite}d`,
            });
          }
        } else if (campo === 'taxa_cessao') {
          // Comparação simples com TX_CESSAO declaratório (retrocompat)
          const cdiVigente = resolveCdi(p, cdiSpotAa);
          let taxaMinima = valorLimite;
          if (unidade === 'percentual_cdi' && cdiVigente > 0) {
            taxaMinima = cdiVigente * (valorLimite / 100);
          }
          const txCessao = normalizeTaxaAnualDeclarada(dc.tx_cessao || dc.tx_juro);
          if (txCessao > 0 && opCompare(txCessao, operador, taxaMinima)) {
            motivos.push({
              regra_codigo: rule.codigo,
              regra_descricao: `${rule.descricao} (${valorLimite}% × ${cdiVigente}% = ${taxaMinima.toFixed(2)}%)`,
              valor_atual: txCessao,
              valor_limite: taxaMinima,
            });
          }
        } else if (campo === 'taxa_cessao_implicita') {
          // Taxa implícita dos fluxos reais (TOTAL_NOMINAL/TOTAL_AQUISICAO), juros compostos base 252 du
          // Avaliada por cedente (lote inteiro), resultado aplicado a todos os DCs do cedente
          const cdiAa      = resolveCdi(p, cdiSpotAa) / 100;
          const percentual = Number(p.valor_limite) || 140;
          const cedenteDoc = cleanDoc(dc.cpf_cnpj_cedente);
          if (!cedenteDoc || cdiAa <= 0) continue;
          const grupo = cedenteGroup.get(cedenteDoc);
          if (!grupo || grupo.total_aquisicao <= 0) continue;

          // CDI_DU = (1 + CDI_AA)^(1/252) - 1
          const cdiDu     = Math.pow(1 + cdiAa, 1 / 252) - 1;
          // Aplica o múltiplo na taxa DIÁRIA (correto matematicamente)
          const taxaMinDu = (percentual / 100) * cdiDu;
          // FV mínimo que o lote deve render para ser elegível
          const fvMinimo  = grupo.total_aquisicao * Math.pow(1 + taxaMinDu, grupo.prazo_max);
          // Taxa implícita anualizada (para exibição no motivo)
          const taxaImplicitaAa = Math.pow(grupo.total_nominal / grupo.total_aquisicao, 252 / grupo.prazo_max) - 1;
          // Taxa mínima anualizada equivalente (para exibição no motivo)
          const taxaMinAa = Math.pow(1 + taxaMinDu, 252) - 1;

          if (grupo.total_nominal < fvMinimo) {
            motivos.push({
              regra_codigo: rule.codigo,
              regra_descricao: rule.descricao,
              valor_atual: `${(taxaImplicitaAa * 100).toFixed(2)}% a.a. implícita (FV ${grupo.total_nominal.toFixed(2)})`,
              valor_limite: `${(taxaMinAa * 100).toFixed(2)}% a.a. = ${percentual}%×CDI ${(cdiAa * 100).toFixed(2)}% (FV mín. ${fvMinimo.toFixed(2)})`,
            });
          }
        } else if (campo === 'inadimplencia_cedente') {
          const cedenteDoc = cleanDoc(dc.cpf_cnpj_cedente);
          if (cedenteDoc) {
            const maiorAtraso = cedenteInadimplenteDias.get(cedenteDoc) ?? 0;
            if (opCompare(valorLimite, '<=', maiorAtraso)) {
              motivos.push({
                regra_codigo: rule.codigo,
                regra_descricao: rule.descricao,
                valor_atual: `${maiorAtraso}d atraso`,
                valor_limite: `${valorLimite}d`,
              });
            }
          }
        } else if (campo === 'tipo_recebivel') {
          const filtro = p.filtro_tipo_recebivel;
          if (Array.isArray(filtro) && filtro.length > 0) {
            if (!matchesTipoRecebivel(dc, filtro)) {
              motivos.push({
                regra_codigo: rule.codigo,
                regra_descricao: rule.descricao,
                valor_atual: dc.nm_tipo_recebivel,
                valor_limite: filtro.join(', '),
              });
            }
          }
        } else if (campo === 'exposicao_prazo_acima') {
          const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
          const sacadoDoc = cleanDoc(dc.nu_cpf_cnpj_sacado);
          if (sacadoDoc && pl > 0) {
            const faixas = sacadoVencidaExposure.get(sacadoDoc);
            const diasRef = Number(p.dias_referencia) || 90;
            const exposicaoVencida = faixas?.get(diasRef) ?? 0;
            const pctPl = exposicaoVencida / pl;
            if (pctPl > limitePl) {
              motivos.push({
                regra_codigo: rule.codigo,
                regra_descricao: rule.descricao,
                valor_atual: `${(pctPl * 100).toFixed(2)}% PL`,
                valor_limite: `${(limitePl * 100).toFixed(2)}% PL`,
              });
            }
          }
        } else if (campo === 'substituicao_unica') {
          // Avaliado somente em recompras (passo 8b)
          continue;
        }
      }

      // Etapa cadastro de partes (comitê consultoria)
      if (cadastroRule && cadastroParams) {
        if (cadastroParams.verificar_cedente) {
          const cedenteDoc = cleanDoc(dc.cpf_cnpj_cedente);
          if (cedenteDoc) {
            motivos.push(...avaliarCadastroParte(
              cedenteDoc,
              dc.nm_cedente,
              'cedente',
              dataCessao,
              cadastroMapCedente,
              cadastroParams,
            ));
          }
        }
        if (cadastroParams.verificar_sacado) {
          const sacadoDoc = cleanDoc(dc.nu_cpf_cnpj_sacado);
          const cedenteDoc = cleanDoc(dc.cpf_cnpj_cedente);
          const temCoobrigacao = cedenteDoc ? (coobrigacaoCedentes[cedenteDoc] ?? true) : true;
          // Com coobrigação: risco do sacado fica com o cedente — não aplica vedações de cadastro do sacado.
          if (sacadoDoc && !temCoobrigacao) {
            motivos.push(...avaliarCadastroParte(
              sacadoDoc,
              dc.nm_sacado,
              'sacado',
              dataCessao,
              cadastroMapSacado,
              cadastroParams,
            ));
          }
        }
      }

      const semVeto = motivos.filter(m => m.severidade !== 'alerta').length === 0;
      results.push({ dc, elegivel: semVeto, enquadra: semVeto, motivos });
    }

    // ── 8b. Avaliar regras de substituição/recompra (somente RECOMPRA) ─
    const substituicaoRules = individualRules.filter(
      r => (r.parametros.campo as string) === 'substituicao_unica',
    );
    const recompraResults: DcResult[] = [];

    for (const dc of dcsRecompra) {
      if (substituicaoRules.length === 0) {
        recompraResults.push({ dc, elegivel: null, enquadra: null, motivos: [] });
        continue;
      }

      const motivos: MotivoRejeicao[] = [];

      for (const rule of substituicaoRules) {
        const p = rule.parametros;
        const tiposPermitidos: string[] =
          (p.tipos_permitidos as string[]) ??
          ['duplicata', 'ccb', 'nota comercial', 'cce'];

        const tipoNorm = (dc.nm_tipo_recebivel || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '');

        const tipoValido = tiposPermitidos.some(t =>
          tipoNorm.includes(t.toLowerCase()
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')),
        );

        if (!tipoValido) {
          motivos.push({
            regra_codigo: rule.codigo,
            regra_descricao: rule.descricao,
            valor_atual: dc.nm_tipo_recebivel || 'tipo não identificado',
            valor_limite: `permitidos: ${tiposPermitidos.join(', ')}`,
          });
        }

        const docRef = (dc.ds_nu_documento || dc.ds_seu_numero || '').trim();
        const cedenteDoc = cleanDoc(dc.cpf_cnpj_cedente);
        const chave = `${docRef}|${cedenteDoc}`;

        // Prioridade dos motivos (1º push → regraDetalhes.valor_atual):
        // tipo inválido > ativo no estoque > 2ª recompra
        if (docRef && estoqueAtivoSet.has(chave)) {
          motivos.push({
            regra_codigo: rule.codigo,
            regra_descricao: rule.descricao,
            valor_atual: `documento ${docRef} ainda ativo no estoque`,
            valor_limite: 'título substituído deve estar liquidado/baixado (não ativo)',
          });
        }

        if (docRef && recompraHistoricoSet.has(chave)) {
          motivos.push({
            regra_codigo: rule.codigo,
            regra_descricao: rule.descricao,
            valor_atual: `documento ${docRef} já foi recomprado anteriormente`,
            valor_limite: 'máximo 1 recompra por título por cedente',
          });
        }
      }

      const elegivel = motivos.length === 0;
      recompraResults.push({ dc, elegivel, enquadra: elegivel, motivos });
    }

    // ── 9. Simular pró-forma e concentração ───────────────────────────

    const elegiveisIdx = results
      .map((r, i) => r.elegivel ? i : -1)
      .filter(i => i >= 0);

    const proposedBySacado = new Map<string, number>();
    const proposedByCedente = new Map<string, number>();
    // Maps por grupo econômico para os DCs propostos
    const proposedBySacadoGrupo = new Map<string, number>();
    const proposedByCedenteGrupo = new Map<string, number>();
    // Nomes de grupos para DCs propostos (complementa os do estoque)
    const grupoSacadoNomeProposed = new Map<string, string>();
    const grupoCedenteNomeProposed = new Map<string, string>();

    let proposedSemCoobrigacao = 0;
    let proposedVpTotal = 0;
    let proposedPrazoSoma = 0;

    // ── Mapas de recompra para subtrair exposição na concentração ────
    // Recompras reduzem exposição de cedente/sacado (o fundo devolve o título).
    const recompraBySacadoGrupo = new Map<string, number>();
    const recompraByCedenteGrupo = new Map<string, number>();
    const recompraByCedente = new Map<string, number>();
    for (const dc of dcsRecompra) {
      const sacado = cleanDoc(dc.nu_cpf_cnpj_sacado);
      const cedente = cleanDoc(dc.cpf_cnpj_cedente);
      const vp = dc.vl_pago;
      if (sacado) {
        const gSacado = resolverGrupo(sacado, dc.nm_sacado, grupoEconomicoMap);
        recompraBySacadoGrupo.set(gSacado.chave, (recompraBySacadoGrupo.get(gSacado.chave) ?? 0) + vp);
      }
      if (cedente) {
        recompraByCedente.set(cedente, (recompraByCedente.get(cedente) ?? 0) + vp);
        const gCedente = resolverGrupo(cedente, dc.nm_cedente, grupoEconomicoMap);
        recompraByCedenteGrupo.set(gCedente.chave, (recompraByCedenteGrupo.get(gCedente.chave) ?? 0) + vp);
      }
    }

    for (const idx of elegiveisIdx) {
      const dc = results[idx].dc;
      const sacado = cleanDoc(dc.nu_cpf_cnpj_sacado);
      const cedente = cleanDoc(dc.cpf_cnpj_cedente);
      const vp = dc.vl_pago;

      if (sacado) {
        proposedBySacado.set(sacado, (proposedBySacado.get(sacado) ?? 0) + vp);
        const gSacado = resolverGrupo(sacado, dc.nm_sacado, grupoEconomicoMap);
        proposedBySacadoGrupo.set(gSacado.chave, (proposedBySacadoGrupo.get(gSacado.chave) ?? 0) + vp);
        if (!grupoSacadoNome.has(gSacado.chave) && !grupoSacadoNomeProposed.has(gSacado.chave))
          grupoSacadoNomeProposed.set(gSacado.chave, gSacado.nomeGrupo);
      }
      if (cedente) {
        proposedByCedente.set(cedente, (proposedByCedente.get(cedente) ?? 0) + vp);
        const gCedente = resolverGrupo(cedente, dc.nm_cedente, grupoEconomicoMap);
        proposedByCedenteGrupo.set(gCedente.chave, (proposedByCedenteGrupo.get(gCedente.chave) ?? 0) + vp);
        if (!grupoCedenteNome.has(gCedente.chave) && !grupoCedenteNomeProposed.has(gCedente.chave))
          grupoCedenteNomeProposed.set(gCedente.chave, gCedente.nomeGrupo);
      }

      // Soma como "sem coobrigação" apenas se o cedente foi marcado como SEM coobrigação no dialog
      // default conservador: se não foi informado, trata como COM coobrigação (não entra no limite)
      const temCoobrigacao = cedente ? (coobrigacaoCedentes[cedente] ?? true) : true;
      if (!temCoobrigacao) proposedSemCoobrigacao += vp;
      proposedVpTotal += vp;
      proposedPrazoSoma += dc.prazo * vp;
    }

    // Helper: dado um grupo-chave, retorna o nome amigável
    const nomeDeGrupoSacado = (chave: string): string =>
      grupoSacadoNome.get(chave) ?? grupoSacadoNomeProposed.get(chave) ?? chave;
    const nomeDeGrupoCedente = (chave: string): string =>
      grupoCedenteNome.get(chave) ?? grupoCedenteNomeProposed.get(chave) ?? chave;

    if (proformaRules.length > 0 && pl > 0) {
      for (const rule of proformaRules) {
        const p = rule.parametros;

        if (rule.tipo_regra.startsWith('CONCENTRACAO_')) {
          const limiteMax = normalizarLimite(p.limite_max) ?? 0.05;
          const baseCalculo = (p.base_calculo as string) || 'valor_presente';

          // Concentração usa valor líquido (VP − PDD) por padrão; desabilitar com usar_abatimento_pdd: false
          const usarPdd = p.usar_abatimento_pdd !== false;
          if (rule.tipo_regra === 'CONCENTRACAO_DEVEDOR') {
            // Concentração considera grupo econômico inteiro conforme regulamento
            for (const idx of elegiveisIdx) {
              if (!results[idx].enquadra) continue;
              const sacado = cleanDoc(results[idx].dc.nu_cpf_cnpj_sacado);
              if (!sacado) continue;
              const gSacado = resolverGrupo(sacado, results[idx].dc.nm_sacado, grupoEconomicoMap);
              const estoqueExp = usarPdd
                ? (estoqueBySacadoGrupoLiq.get(gSacado.chave) ?? 0)
                : (estoqueBySacadoGrupo.get(gSacado.chave) ?? 0);
              const totalExp = exposicaoProforma(estoqueExp, proposedBySacadoGrupo.get(gSacado.chave) ?? 0, recompraBySacadoGrupo.get(gSacado.chave) ?? 0);
              const pctPl = totalExp / pl;
              if (pctPl > limiteMax) {
                results[idx].enquadra = false;
                const sufixo = gSacado.isGrupo ? ` [grupo: ${gSacado.nomeGrupo}]` : '';
                results[idx].motivos.push({ regra_codigo: rule.codigo, regra_descricao: rule.descricao, valor_atual: `${(pctPl * 100).toFixed(2)}%${sufixo}`, valor_limite: `${(limiteMax * 100).toFixed(2)}%` });
              }
            }
          } else if (rule.tipo_regra === 'CONCENTRACAO_CEDENTE') {
            // Concentração considera grupo econômico inteiro conforme regulamento
            for (const idx of elegiveisIdx) {
              if (!results[idx].enquadra) continue;
              const cedente = cleanDoc(results[idx].dc.cpf_cnpj_cedente);
              if (!cedente) continue;
              const gCedente = resolverGrupo(cedente, results[idx].dc.nm_cedente, grupoEconomicoMap);
              const estoqueExp = usarPdd
                ? (estoqueByCedenteGrupoLiq.get(gCedente.chave) ?? 0)
                : (estoqueByCedenteGrupo.get(gCedente.chave) ?? 0);
              const totalExp = exposicaoProforma(estoqueExp, proposedByCedenteGrupo.get(gCedente.chave) ?? 0, recompraByCedenteGrupo.get(gCedente.chave) ?? 0);
              const pctPl = totalExp / pl;
              if (pctPl > limiteMax) {
                results[idx].enquadra = false;
                const sufixo = gCedente.isGrupo ? ` [grupo: ${gCedente.nomeGrupo}]` : '';
                results[idx].motivos.push({ regra_codigo: rule.codigo, regra_descricao: rule.descricao, valor_atual: `${(pctPl * 100).toFixed(2)}%${sufixo}`, valor_limite: `${(limiteMax * 100).toFixed(2)}%` });
              }
            }
          } else if (rule.tipo_regra === 'CONCENTRACAO_SEM_COOBRIGACAO') {
            const totalSemCoobrigacao = estoqueSemCoobrigacaoTotal + proposedSemCoobrigacao;
            const pctPl = totalSemCoobrigacao / pl;
            if (pctPl > limiteMax) {
              // Só bloqueia DCs que SÃO sem coobrigação — DCs com coobrigação não
              // contribuem para essa exposição e não devem ser desenquadrados.
              // Se a violação vem apenas do estoque preexistente, o alerta aparece
              // no checklist (violacao_percentual) sem rejeitar a cessão proposta.
              for (const idx of elegiveisIdx) {
                if (!results[idx].enquadra) continue;
                const cedente = cleanDoc(results[idx].dc.cpf_cnpj_cedente);
                const temCoobrigacao = cedente ? (coobrigacaoCedentes[cedente] ?? true) : true;
                if (!temCoobrigacao) {
                  results[idx].enquadra = false;
                  results[idx].motivos.push({ regra_codigo: rule.codigo, regra_descricao: rule.descricao, valor_atual: `${(pctPl * 100).toFixed(2)}%`, valor_limite: `${(limiteMax * 100).toFixed(2)}%` });
                }
              }
            }
          }
          continue;
        }

        // CESSAO_CONDICAO com modo proforma/concentracao
        const campo = (p.campo as string) || '';
        const operador = (p.operador as string) || '<=';
        const valorLimite = Number(p.valor_limite) || 0;
        const unidade = (p.unidade as string) || 'dias';
        const modo = (p.modo as string) || 'proforma';

        if (campo === 'prazo_medio') {
          // Exclui vencidos do estoque (prazo_atual < 0) — só a carteira a vencer entra no prazo médio
          const totalVp = carteiraVPAVencer + proposedVpTotal;
          const totalPrazoSoma = carteiraPrazoSomaAVencer + proposedPrazoSoma;
          const prazoMedioProforma = totalVp > 0 ? totalPrazoSoma / totalVp : 0;
          if (opCompare(prazoMedioProforma, operador, valorLimite)) {
            for (const idx of elegiveisIdx) {
              if (!results[idx].enquadra) continue;
              results[idx].enquadra = false;
              results[idx].motivos.push({
                regra_codigo: rule.codigo,
                regra_descricao: rule.descricao,
                valor_atual: `${prazoMedioProforma.toFixed(1)}d`,
                valor_limite: `${valorLimite}d`,
              });
            }
          }
        } else if (campo === 'exposicao_prazo_acima') {
          // Verificação AGREGADA pró-forma: soma exposição do estoque + cessão elegível
          const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
          const diasRef = Number(p.dias_referencia) || 90;
          const filtro = p.filtro_tipo_recebivel;
          if (pl > 0) {
            // Estoque: títulos com prazo_atual > diasRef E tipo_recebivel correspondente ao filtro
            const estoqueExpPrazo = estoqueRows
              .filter(r => (Number(r.prazo_atual) || 0) > diasRef && matchesTipoRecebivelEstoque(r, filtro))
              .reduce((s, r) => s + (Number(r.valor_nominal) || Number(r.valor_presente) || 0), 0);
            // CSV elegível: apenas títulos com tipo e prazo correspondentes
            const proposedExpPrazo = elegiveisIdx
              .filter(idx => results[idx].enquadra && matchesTipoRecebivel(results[idx].dc, filtro) && results[idx].dc.prazo > diasRef)
              .reduce((s, idx) => s + results[idx].dc.vl_pago, 0);
            const totalExpPrazo = estoqueExpPrazo + proposedExpPrazo;
            const pctPl = totalExpPrazo / pl;
            if (pctPl > limitePl) {
              for (const idx of elegiveisIdx) {
                if (!results[idx].enquadra) continue;
                if (!matchesTipoRecebivel(results[idx].dc, filtro)) continue;
                if (results[idx].dc.prazo <= diasRef) continue;
                results[idx].enquadra = false;
                results[idx].motivos.push({
                  regra_codigo: rule.codigo,
                  regra_descricao: rule.descricao,
                  valor_atual: `${(pctPl * 100).toFixed(2)}% PL (total >${diasRef}du)`,
                  valor_limite: `${(limitePl * 100).toFixed(2)}% PL (>${diasRef}du)`,
                });
              }
            }
          }
        } else if (campo === 'concentracao_devedor') {
          const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
          // Usa VP líquido (VP − PDD) por padrão; desabilitar com usar_abatimento_pdd: false
          const usarPddConc = p.usar_abatimento_pdd !== false;
          // Concentração considera grupo econômico inteiro conforme regulamento
          for (const idx of elegiveisIdx) {
            if (!results[idx].enquadra) continue;
            const sacado = cleanDoc(results[idx].dc.nu_cpf_cnpj_sacado);
            if (!sacado) continue;
            const gSacado = resolverGrupo(sacado, results[idx].dc.nm_sacado, grupoEconomicoMap);
            const estoqueExp = usarPddConc
              ? (estoqueBySacadoGrupoLiq.get(gSacado.chave) ?? 0)
              : (estoqueBySacadoGrupo.get(gSacado.chave) ?? 0);
            const totalExp = exposicaoProforma(estoqueExp, proposedBySacadoGrupo.get(gSacado.chave) ?? 0, recompraBySacadoGrupo.get(gSacado.chave) ?? 0);
            const pctPl = totalExp / pl;
            if (opCompare(limitePl, '<=', pctPl)) {
              results[idx].enquadra = false;
              const sufixo = gSacado.isGrupo ? ` [grupo: ${gSacado.nomeGrupo}]` : '';
              results[idx].motivos.push({ regra_codigo: rule.codigo, regra_descricao: rule.descricao, valor_atual: `${(pctPl * 100).toFixed(2)}%${sufixo}`, valor_limite: `${(limitePl * 100).toFixed(2)}%` });
            }
          }
        } else if (campo === 'concentracao_cedente') {
          const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
          const usarPddConc = p.usar_abatimento_pdd !== false;
          // Concentração considera grupo econômico inteiro conforme regulamento
          for (const idx of elegiveisIdx) {
            if (!results[idx].enquadra) continue;
            const cedente = cleanDoc(results[idx].dc.cpf_cnpj_cedente);
            if (!cedente) continue;
            const gCedente = resolverGrupo(cedente, results[idx].dc.nm_cedente, grupoEconomicoMap);
            const estoqueExp = usarPddConc
              ? (estoqueByCedenteGrupoLiq.get(gCedente.chave) ?? 0)
              : (estoqueByCedenteGrupo.get(gCedente.chave) ?? 0);
            const totalExp = exposicaoProforma(estoqueExp, proposedByCedenteGrupo.get(gCedente.chave) ?? 0, recompraByCedenteGrupo.get(gCedente.chave) ?? 0);
            const pctPl = totalExp / pl;
            if (opCompare(limitePl, '<=', pctPl)) {
              results[idx].enquadra = false;
              const sufixo = gCedente.isGrupo ? ` [grupo: ${gCedente.nomeGrupo}]` : '';
              results[idx].motivos.push({ regra_codigo: rule.codigo, regra_descricao: rule.descricao, valor_atual: `${(pctPl * 100).toFixed(2)}%${sufixo}`, valor_limite: `${(limitePl * 100).toFixed(2)}%` });
            }
          }
        } else if (campo === 'sem_coobrigacao') {
          const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
          const totalSemCoobrigacao = estoqueSemCoobrigacaoTotal + proposedSemCoobrigacao;
          const pctPl = totalSemCoobrigacao / pl;
          if (opCompare(limitePl, '<=', pctPl)) {
            for (const idx of elegiveisIdx) {
              if (!results[idx].enquadra) continue;
              results[idx].enquadra = false;
              results[idx].motivos.push({ regra_codigo: rule.codigo, regra_descricao: rule.descricao, valor_atual: `${(pctPl * 100).toFixed(2)}%`, valor_limite: `${(limitePl * 100).toFixed(2)}%` });
            }
          }
        } else if (campo === 'taxa_cessao' && modo === 'proforma') {
          const cdiVigente = resolveCdi(p, cdiSpotAa);
          let taxaMinima = valorLimite;
          if (unidade === 'percentual_cdi' && cdiVigente > 0) {
            taxaMinima = cdiVigente * (valorLimite / 100);
          }
          // Taxa média ponderada pró-forma
          const estoqueVpAVencer = estoqueRows.filter(r => (Number(r.prazo_atual) || 0) >= 0).reduce((s, r) => s + (Number(r.valor_presente) || 0), 0);
          const totalVpProforma = estoqueVpAVencer + proposedVpTotal;
          if (totalVpProforma > 0) {
            const taxaMediaProposta = proposedVpTotal > 0
              ? elegiveisIdx.reduce((s, idx) => s + normalizeTaxaAnualDeclarada(results[idx].dc.tx_cessao || results[idx].dc.tx_juro) * results[idx].dc.vl_pago, 0) / proposedVpTotal
              : 0;
            if (taxaMediaProposta > 0 && taxaMediaProposta < taxaMinima) {
              for (const idx of elegiveisIdx) {
                if (!results[idx].enquadra) continue;
                results[idx].enquadra = false;
                results[idx].motivos.push({
                  regra_codigo: rule.codigo,
                  regra_descricao: `${rule.descricao} (${valorLimite}% × ${cdiVigente}% = ${taxaMinima.toFixed(2)}%)`,
                  valor_atual: `${taxaMediaProposta.toFixed(2)}%`,
                  valor_limite: `${taxaMinima.toFixed(2)}%`,
                });
              }
            }
          }
        }
      }
    }

    // ── 9b. Limite R$ de comitê (cadastro de partes) ─────────────────
    const cedentesNaCessao = new Set(
      dcsAquisicao.map(dc => cleanDoc(dc.cpf_cnpj_cedente)).filter(Boolean),
    );
    let cadastroLimiteStockOnly = false;

    if (cadastroRule && cadastroParams) {
      const usarPddCad = cadastroParams.usar_abatimento_pdd !== false;
      const estoqueByDocCad = new Map<string, number>();
      const estoqueByGrupoCad = new Map<string, number>();

      for (const r of estoqueRows) {
        const doc = cleanDoc(r.doc_cedente);
        if (!doc) continue;
        const vn = Number(r.valor_nominal) || Number(r.valor_presente) || 0;
        const pdd = Number(r.valor_pdd) || Number(r.valor_pdd_geral) || 0;
        const exp = usarPddCad ? Math.max(vn - pdd, 0) : vn;
        estoqueByDocCad.set(doc, (estoqueByDocCad.get(doc) ?? 0) + exp);
        const cad = cadastroMap.get(doc);
        if (cad?.escopo_limite === 'grupo' && cad.grupo_chave) {
          estoqueByGrupoCad.set(
            cad.grupo_chave,
            (estoqueByGrupoCad.get(cad.grupo_chave) ?? 0) + exp,
          );
        }
      }

      const processedGruposCad = new Set<string>();

      for (const cadastro of cadastroPartesCedente) {
        if (cadastro.limite_operacao == null) continue;

        let totalExp = 0;
        let chaveAlvo = cadastro.doc_cnpj_cpf;
        let docsDoGrupo: string[] = [cadastro.doc_cnpj_cpf];
        let labelGrupo = cadastro.nome ?? cadastro.doc_cnpj_cpf;

        if (cadastro.escopo_limite === 'grupo' && cadastro.grupo_chave) {
          if (processedGruposCad.has(cadastro.grupo_chave)) continue;
          processedGruposCad.add(cadastro.grupo_chave);
          chaveAlvo = cadastro.grupo_chave;
          const grupoRows = cadastroGrupoMap.get(cadastro.grupo_chave) ?? [cadastro];
          docsDoGrupo = grupoRows.map(g => g.doc_cnpj_cpf);
          labelGrupo = grupoRows.map(g => g.nome).filter(Boolean).join(' + ') || cadastro.grupo_chave;
          const limites = grupoRows.map(g => g.limite_operacao).filter((v): v is number => v != null);
          const limiteEfetivo = limites.length ? Math.min(...limites) : cadastro.limite_operacao;
          const estoqueExp = estoqueByGrupoCad.get(cadastro.grupo_chave) ?? 0;
          let proposedExp = 0;
          let recompraExp = 0;
          for (const d of docsDoGrupo) {
            proposedExp += proposedByCedente.get(d) ?? 0;
            recompraExp += recompraByCedente.get(d) ?? 0;
          }
          totalExp = exposicaoProforma(estoqueExp, proposedExp, recompraExp);
          if (totalExp > limiteEfetivo) {
            const temDcNovo = docsDoGrupo.some(d => cedentesNaCessao.has(d));
            if (!temDcNovo) cadastroLimiteStockOnly = true;
            for (const idx of elegiveisIdx) {
              if (!results[idx].enquadra) continue;
              const ced = cleanDoc(results[idx].dc.cpf_cnpj_cedente);
              if (!ced || !docsDoGrupo.includes(ced)) continue;
              results[idx].enquadra = false;
              results[idx].motivos.push({
                regra_codigo: 'LIMITE_COMITE_EXCEDIDO',
                regra_descricao: cadastroRule.descricao,
                valor_atual: `${formatBRL(totalExp)} (grupo ${cadastro.grupo_chave})`,
                valor_limite: formatBRL(limiteEfetivo),
                severidade: 'vedacao',
              });
            }
          }
          continue;
        }

        const estoqueExp = estoqueByDocCad.get(cadastro.doc_cnpj_cpf) ?? 0;
        const proposedExp = proposedByCedente.get(cadastro.doc_cnpj_cpf) ?? 0;
        const recompraExp = recompraByCedente.get(cadastro.doc_cnpj_cpf) ?? 0;
        totalExp = exposicaoProforma(estoqueExp, proposedExp, recompraExp);

        if (totalExp > cadastro.limite_operacao) {
          if (!cedentesNaCessao.has(cadastro.doc_cnpj_cpf)) cadastroLimiteStockOnly = true;
          for (const idx of elegiveisIdx) {
            if (!results[idx].enquadra) continue;
            const ced = cleanDoc(results[idx].dc.cpf_cnpj_cedente);
            if (ced !== cadastro.doc_cnpj_cpf) continue;
            results[idx].enquadra = false;
            results[idx].motivos.push({
              regra_codigo: 'LIMITE_COMITE_EXCEDIDO',
              regra_descricao: cadastroRule.descricao,
              valor_atual: formatBRL(totalExp),
              valor_limite: formatBRL(cadastro.limite_operacao),
              severidade: 'vedacao',
            });
          }
        }
      }
    }

    // Snapshot de métricas por regra (checklist pré-trade — inclusive quando status = ok)
    // breakdown: lista de cedentes/sacados para concentração, ou DCs individuais para outras regras
    interface BreakdownRow {
      tipo_item: 'cedente' | 'sacado' | 'dc';
      tipo_linha?: 'resumo' | 'titulo' | 'taxa' | 'cadastro_limite';
      origem?: 'estoque' | 'csv' | 'proforma';
      label: string;
      doc: string;
      documento?: string;
      cedente?: string;
      sacado?: string;
      prazo?: number;
      dt_vencimento?: string | null;
      total_aquisicao?: number | null;
      coobrigacao?: string | null;
      valor_rs?: number;
      estoque_rs?: number;
      proposto_rs?: number;
      total_rs?: number;
      pct_pl?: number;
      limite_pct_pl?: number;
      /** Exibição em du para composição de prazo médio (substitui % PL na UI) */
      valor_atual_texto?: string;
      limite_texto?: string;
      pct_uso_limite?: number | null;
      valor_extra?: string;
      status: 'ok' | 'violacao';
    }
    const checklistSnapshot = new Map<string, { valor_atual: string | null; valor_limite: string | null; breakdown: BreakdownRow[]; detalhes_origem: BreakdownRow[]; violacao_percentual?: boolean }>();

    for (const rule of rules) {
      const p = rule.parametros;
      let va: string | null = null;
      let vl: string | null = null;
      const bd: BreakdownRow[] = [];
      const detalhesOrigem: BreakdownRow[] = [];
      let violacaoPercentualCessao: boolean | undefined = undefined;

      if (rule.tipo_regra.startsWith('CONCENTRACAO_')) {
        const limiteMax = normalizarLimite(p.limite_max) ?? 0.05;
        const baseCalculo = (p.base_calculo as string) || 'valor_presente';
        vl = `máx. ${(limiteMax * 100).toFixed(2)}% do PL`;
        if (pl <= 0) {
          va = 'PL indisponível';
        } else if (rule.tipo_regra === 'CONCENTRACAO_SEM_COOBRIGACAO') {
          const totalSemCoobrigacao = estoqueSemCoobrigacaoTotal + proposedSemCoobrigacao;
          const pctTotal = pl > 0 ? totalSemCoobrigacao / pl : 0;
          const semCoobLabel = Object.values(coobrigacaoCedentes).some(v => !v)
            ? `estoque + cessão s/ coob. (${Object.entries(coobrigacaoCedentes).filter(([,v]) => !v).length} cedente(s) sem coob.)`
            : 'estoque (nenhum cedente da cessão sem coob.)';
          va = `${(pctTotal * 100).toFixed(2)}% do PL (${semCoobLabel})`;
          bd.push({
            tipo_item: 'cedente',
            tipo_linha: 'resumo',
            origem: 'estoque',
            label: 'Estoque_FIDC',
            doc: '',
            estoque_rs: estoqueSemCoobrigacaoTotal,
            proposto_rs: 0,
            total_rs: estoqueSemCoobrigacaoTotal,
            pct_pl: pl > 0 ? (estoqueSemCoobrigacaoTotal / pl) * 100 : 0,
            limite_pct_pl: limiteMax * 100,
            status: pl > 0 && (estoqueSemCoobrigacaoTotal / pl) > limiteMax ? 'violacao' : 'ok',
          });
          bd.push({
            tipo_item: 'cedente',
            tipo_linha: 'resumo',
            origem: 'csv',
            label: 'CSV importado',
            doc: '',
            estoque_rs: 0,
            proposto_rs: proposedSemCoobrigacao,
            total_rs: proposedSemCoobrigacao,
            pct_pl: pl > 0 ? (proposedSemCoobrigacao / pl) * 100 : 0,
            limite_pct_pl: limiteMax * 100,
            status: pl > 0 && (proposedSemCoobrigacao / pl) > limiteMax ? 'violacao' : 'ok',
          });
          bd.push({
            tipo_item: 'cedente',
            tipo_linha: 'resumo',
            origem: 'proforma',
            label: 'Pró-forma total',
            doc: '',
            estoque_rs: estoqueSemCoobrigacaoTotal,
            proposto_rs: proposedSemCoobrigacao,
            total_rs: totalSemCoobrigacao,
            pct_pl: pctTotal * 100,
            limite_pct_pl: limiteMax * 100,
            status: pctTotal > limiteMax ? 'violacao' : 'ok',
          });

          for (const row of estoqueRows) {
            const coobr = normalizarCoobrigacao(row.coobrigacao);
            if (coobr !== false) continue;
            detalhesOrigem.push({
              tipo_item: 'dc',
              tipo_linha: 'titulo',
              origem: 'estoque',
              label: row.seu_numero || row.nu_documento || 'Sem documento',
              doc: cleanDoc(row.doc_cedente),
              documento: row.seu_numero || row.nu_documento || '',
              cedente: row.nome_cedente || row.doc_cedente || '—',
              sacado: row.nome_sacado || row.doc_sacado || '—',
              prazo: Number(row.prazo) || 0,
              dt_vencimento: row.data_vencimento_ajustada,
              total_aquisicao: null,
              coobrigacao: row.coobrigacao,
              valor_rs: Number(row.valor_nominal) || Number(row.valor_presente) || 0,
              status: 'ok',
            });
          }
          for (const idx of elegiveisIdx) {
            const dc = results[idx].dc;
            const cedente = cleanDoc(dc.cpf_cnpj_cedente);
            const temCoobrigacao = cedente ? (coobrigacaoCedentes[cedente] ?? true) : true;
            if (temCoobrigacao) continue;
            detalhesOrigem.push({
              tipo_item: 'dc',
              tipo_linha: 'titulo',
              origem: 'csv',
              label: dc.ds_seu_numero || dc.ds_nu_documento || 'Sem documento',
              doc: cedente,
              documento: dc.ds_seu_numero || dc.ds_nu_documento || '',
              cedente: dc.nm_cedente || dc.cpf_cnpj_cedente || '—',
              sacado: dc.nm_sacado || dc.nu_cpf_cnpj_sacado || '—',
              prazo: dc.prazo,
              dt_vencimento: dc.dt_vencimento,
              total_aquisicao: dc.total_aquisicao || null,
              coobrigacao: 'N',
              valor_rs: dc.vl_pago,
              status: 'ok',
            });
          }
          checklistSnapshot.set(rule.codigo, { valor_atual: va, valor_limite: vl, breakdown: bd, detalhes_origem: detalhesOrigem, violacao_percentual: pctTotal > limiteMax });
          continue;
        } else if (rule.tipo_regra === 'CONCENTRACAO_CEDENTE') {
          // Todos os cedentes do CSV (não só elegíveis) para dar visibilidade completa.
          // Agrupa por grupo econômico — empresas do mesmo grupo são consolidadas.
          const usarPddChkC = p.usar_abatimento_pdd !== false;
          // Coletar grupos únicos de cedentes presentes no CSV
          const allCedentesGrupo = new Map<string, string>(); // chave → nome
          for (const dc of dcs) {
            const doc = cleanDoc(dc.cpf_cnpj_cedente);
            if (!doc) continue;
            const g = resolverGrupo(doc, dc.nm_cedente, grupoEconomicoMap);
            if (!allCedentesGrupo.has(g.chave)) allCedentesGrupo.set(g.chave, g.nomeGrupo);
          }
          let maxPct = 0;
          for (const [chave, nome] of allCedentesGrupo) {
            const estoqueExp = usarPddChkC
              ? (estoqueByCedenteGrupoLiq.get(chave) ?? 0)
              : (estoqueByCedenteGrupo.get(chave) ?? 0);
            const proposedExp = proposedByCedenteGrupo.get(chave) ?? 0;
            const totalExp = exposicaoProforma(estoqueExp, proposedExp, recompraByCedenteGrupo.get(chave) ?? 0);
            const pctPl = totalExp / pl;
            maxPct = Math.max(maxPct, pctPl);
            const isGrupo = grupoEconomicoMap.has(chave) || [...grupoEconomicoMap.values()].some(v => v.grupo_id === chave);
            bd.push({
              tipo_item: 'cedente',
              label: isGrupo ? `${nome} ★` : nome,
              doc: chave,
              estoque_rs: estoqueExp,
              proposto_rs: proposedExp,
              total_rs: totalExp,
              pct_pl: pctPl * 100,
              limite_pct_pl: limiteMax * 100,
              status: pctPl > limiteMax ? 'violacao' : 'ok',
            });
          }
          bd.sort((a, b) => (b.pct_pl ?? 0) - (a.pct_pl ?? 0));
          va = `${(maxPct * 100).toFixed(2)}% do PL (pior cedente${allCedentesGrupo.size > 0 && grupoEconomicoMap.size > 0 ? '/grupo' : ''})`;
          checklistSnapshot.set(rule.codigo, { valor_atual: va, valor_limite: vl, breakdown: bd, detalhes_origem: detalhesOrigem, violacao_percentual: maxPct > limiteMax });
          continue;
        } else if (rule.tipo_regra === 'CONCENTRACAO_DEVEDOR') {
          // Agrupa por grupo econômico — empresas do mesmo grupo são consolidadas.
          const usarPddChkD = p.usar_abatimento_pdd !== false;
          const allSacadosGrupo = new Map<string, string>(); // chave → nome
          for (const dc of dcs) {
            const doc = cleanDoc(dc.nu_cpf_cnpj_sacado);
            if (!doc) continue;
            const g = resolverGrupo(doc, dc.nm_sacado, grupoEconomicoMap);
            if (!allSacadosGrupo.has(g.chave)) allSacadosGrupo.set(g.chave, g.nomeGrupo);
          }
          let maxPct = 0;
          for (const [chave, nome] of allSacadosGrupo) {
            const estoqueExp = usarPddChkD
              ? (estoqueBySacadoGrupoLiq.get(chave) ?? 0)
              : (estoqueBySacadoGrupo.get(chave) ?? 0);
            const proposedExp = proposedBySacadoGrupo.get(chave) ?? 0;
            const totalExp = exposicaoProforma(estoqueExp, proposedExp, recompraBySacadoGrupo.get(chave) ?? 0);
            const pctPl = totalExp / pl;
            maxPct = Math.max(maxPct, pctPl);
            const isGrupo = grupoEconomicoMap.has(chave) || [...grupoEconomicoMap.values()].some(v => v.grupo_id === chave);
            bd.push({
              tipo_item: 'sacado',
              label: isGrupo ? `${nome} ★` : nome,
              doc: chave,
              estoque_rs: estoqueExp,
              proposto_rs: proposedExp,
              total_rs: totalExp,
              pct_pl: pctPl * 100,
              limite_pct_pl: limiteMax * 100,
              status: pctPl > limiteMax ? 'violacao' : 'ok',
            });
          }
          bd.sort((a, b) => (b.pct_pl ?? 0) - (a.pct_pl ?? 0));
          va = `${(maxPct * 100).toFixed(2)}% do PL (pior sacado${allSacadosGrupo.size > 0 && grupoEconomicoMap.size > 0 ? '/grupo' : ''})`;
          checklistSnapshot.set(rule.codigo, { valor_atual: va, valor_limite: vl, breakdown: bd, detalhes_origem: detalhesOrigem, violacao_percentual: maxPct > limiteMax });
          continue;
        }
      } else if (rule.tipo_regra === 'CESSAO_CADASTRO_PARTES') {
        vl = 'cadastro vigente + limite R$ comitê';
        const usarPddChk = p.usar_abatimento_pdd !== false;
        let piorUso = 0;
        const processedGruposBreakdown = new Set<string>();
        const processedDocsBreakdown = new Set<string>();
        const cedenteNomeMap = new Map<string, string>();
        for (const dc of dcsAquisicao) {
          const d = cleanDoc(dc.cpf_cnpj_cedente);
          if (d && !cedenteNomeMap.has(d)) cedenteNomeMap.set(d, dc.nm_cedente);
        }

        const estoqueExpDoc = (doc: string) => {
          let exp = 0;
          for (const r of estoqueRows) {
            if (cleanDoc(r.doc_cedente) !== doc) continue;
            const vn = Number(r.valor_nominal) || Number(r.valor_presente) || 0;
            const pdd = Number(r.valor_pdd) || Number(r.valor_pdd_geral) || 0;
            exp += usarPddChk ? Math.max(vn - pdd, 0) : vn;
          }
          return exp;
        };

        for (const cedDoc of cedentesNaCessao) {
          const cad = cadastroMap.get(cedDoc);
          if (!cad) {
            const estoqueExp = estoqueExpDoc(cedDoc);
            const proposedExp = proposedByCedente.get(cedDoc) ?? 0;
            const recompraExp = recompraByCedente.get(cedDoc) ?? 0;
            const totalExp = exposicaoProforma(estoqueExp, proposedExp, recompraExp);
            bd.push({
              tipo_item: 'cedente',
              tipo_linha: 'cadastro_limite',
              label: cedenteNomeMap.get(cedDoc) ?? cedDoc,
              doc: cedDoc,
              estoque_rs: estoqueExp,
              proposto_rs: proposedExp,
              total_rs: totalExp,
              valor_atual_texto: formatBRL(totalExp),
              limite_texto: '—',
              pct_uso_limite: null,
              valor_extra: 'sem cadastro vigente',
              status: 'violacao',
            });
            continue;
          }

          if (processedDocsBreakdown.has(cedDoc)) continue;
          processedDocsBreakdown.add(cedDoc);

          const doc = cad.doc_cnpj_cpf;
          if (cad.escopo_limite === 'grupo' && cad.grupo_chave) {
            if (processedGruposBreakdown.has(cad.grupo_chave)) continue;
            processedGruposBreakdown.add(cad.grupo_chave);
          }

          let estoqueExp = 0;
          let proposedExp = 0;
          let recompraExp = 0;
          let limiteRs = cad.limite_operacao;
          let label = cad.nome ?? doc;
          let docKey = doc;

          if (cad.escopo_limite === 'grupo' && cad.grupo_chave) {
            docKey = cad.grupo_chave;
            label = `${label} ★`;
            const grupoRows = cadastroGrupoMap.get(cad.grupo_chave) ?? [cad];
            const limites = grupoRows.map(g => g.limite_operacao).filter((v): v is number => v != null);
            limiteRs = limites.length ? Math.min(...limites) : limiteRs;
            for (const g of grupoRows) {
              estoqueExp += estoqueExpDoc(g.doc_cnpj_cpf);
              proposedExp += proposedByCedente.get(g.doc_cnpj_cpf) ?? 0;
              recompraExp += recompraByCedente.get(g.doc_cnpj_cpf) ?? 0;
            }
          } else {
            estoqueExp = estoqueExpDoc(doc);
            proposedExp = proposedByCedente.get(doc) ?? 0;
            recompraExp = recompraByCedente.get(doc) ?? 0;
          }

          const totalExp = exposicaoProforma(estoqueExp, proposedExp, recompraExp);
          const pctUso = limiteRs && limiteRs > 0 ? (totalExp / limiteRs) * 100 : null;
          piorUso = Math.max(piorUso, pctUso ?? 0);
          const vencido = cad.dt_validade
            ? isCadastroVencido(dataCessao, cad.dt_validade, cadastroParams?.validade_inclusiva ?? true)
            : false;
          const estourouLimite = limiteRs != null && totalExp > limiteRs;

          bd.push({
            tipo_item: 'cedente',
            tipo_linha: 'cadastro_limite',
            label,
            doc: docKey,
            estoque_rs: estoqueExp,
            proposto_rs: proposedExp,
            total_rs: totalExp,
            valor_atual_texto: formatBRL(totalExp),
            limite_texto: limiteRs != null ? formatBRL(limiteRs) : '—',
            pct_uso_limite: pctUso,
            valor_extra: cad.dt_validade ? `validade ${cad.dt_validade}` : 'revisão pendente',
            status: estourouLimite || vencido || cad.status !== 'ativo' ? 'violacao' : 'ok',
          });
        }

        bd.sort((a, b) => (b.total_rs ?? 0) - (a.total_rs ?? 0));
        va = bd.length
          ? `${bd.length} cedente(s) na cessão`
          : 'nenhum cedente na cessão';
        checklistSnapshot.set(rule.codigo, {
          valor_atual: va,
          valor_limite: vl,
          breakdown: bd,
          detalhes_origem: detalhesOrigem,
          violacao_percentual: cadastroLimiteStockOnly,
        });
        checklistSnapshot.set('LIMITE_COMITE_PARTES', {
          valor_atual: piorUso > 0 ? `pior uso ${piorUso.toFixed(1)}%` : '—',
          valor_limite: 'limite R$ comitê',
          breakdown: bd.filter(b => b.limite_texto && b.limite_texto !== '—'),
          detalhes_origem: [],
          violacao_percentual: cadastroLimiteStockOnly,
        });
        continue;
      } else if (rule.tipo_regra === 'CESSAO_CONDICAO') {
        const modo = (p.modo as string) || 'individual';
        const campo = (p.campo as string) || '';
        const valorLimite = Number(p.valor_limite) || 0;
        const unidade = (p.unidade as string) || 'dias';
        const operador = (p.operador as string) || '<=';

        if (modo === 'individual') {
          if (campo === 'prazo') {
            vl = `${operador} ${valorLimite} du`;
            const filtrados = dcsAquisicao.filter(dc => matchesTipoRecebivel(dc, p.filtro_tipo_recebivel));
            if (filtrados.length) {
              const mx = Math.max(...filtrados.map(d => d.prazo));
              const mn = Math.min(...filtrados.map(d => d.prazo));
              va = filtrados.length === 1 ? `${mx} du` : `${mn} — ${mx} du`;
              for (const dc of filtrados) {
                const violou = opCompare(dc.prazo, operador, valorLimite);
                bd.push({
                  tipo_item: 'dc',
                  tipo_linha: 'titulo',
                  origem: 'csv',
                  label: dc.ds_seu_numero,
                  doc: cleanDoc(dc.cpf_cnpj_cedente),
                  documento: dc.ds_seu_numero || dc.ds_nu_documento || '',
                  cedente: dc.nm_cedente || dc.cpf_cnpj_cedente || '—',
                  sacado: dc.nm_sacado || dc.nu_cpf_cnpj_sacado || '—',
                  prazo: dc.prazo,
                  dt_vencimento: dc.dt_vencimento,
                  total_aquisicao: dc.total_aquisicao || null,
                  valor_extra: `${dc.prazo} du`,
                  status: violou ? 'violacao' : 'ok',
                });
              }
            }
          } else if (campo === 'taxa_cessao') {
            const cdiVigente = resolveCdi(p, cdiSpotAa);
            let taxaMinima = valorLimite;
            if (unidade === 'percentual_cdi' && cdiVigente > 0) {
              taxaMinima = cdiVigente * (valorLimite / 100);
              vl = `≥ ${taxaMinima.toFixed(2)}% a.a. (${valorLimite}% × CDI ${cdiVigente}% a.a.)`;
            } else {
              vl = `${operador} ${valorLimite}% a.a.`;
            }
            const filtrados = dcsAquisicao.filter(dc => matchesTipoRecebivel(dc, p.filtro_tipo_recebivel));
            if (filtrados.length === 0) {
              va = '— (nenhum DC após filtro de tipo)';
            } else {
              // Agrupa por cedente — uma linha por cessão
              const cedenteMap = new Map<string, { nome: string; vp: number; txSoma: number; count: number }>();
              for (const dc of filtrados) {
                const key = cleanDoc(dc.cpf_cnpj_cedente) || dc.nm_cedente || 'desconhecido';
                const nome = dc.nm_cedente || key;
                const tx = normalizeTaxaAnualDeclarada(dc.tx_cessao || dc.tx_juro);
                const existing = cedenteMap.get(key);
                if (!existing) {
                  cedenteMap.set(key, { nome, vp: dc.vl_pago, txSoma: tx * dc.vl_pago, count: 1 });
                } else {
                  existing.vp += dc.vl_pago;
                  existing.txSoma += tx * dc.vl_pago;
                  existing.count++;
                }
              }
              const allTxs: number[] = [];
              for (const [cedenteDoc, grupo] of cedenteMap) {
                const txMedia = grupo.vp > 0 ? grupo.txSoma / grupo.vp : 0;
                allTxs.push(txMedia);
                // violou = opCompare retorna true quando há violação (ex: tx < taxaMinima para >=)
                const violou = txMedia > 0 && opCompare(txMedia, operador, taxaMinima);
                // % do CDI apurada (ex: 37 / 14.75 * 100 = 251%)
                const pctCdi = cdiVigente > 0 ? (txMedia / cdiVigente) * 100 : null;
                bd.push({
                  tipo_item: 'cedente',
                  tipo_linha: 'taxa',
                  label: grupo.nome,
                  doc: cedenteDoc,
                  // pct_pl = taxa apurada % a.a. (ex: 37.00)
                  pct_pl: txMedia,
                  // limite_pct_pl = taxa mínima equivalente % a.a. (ex: 20.65)
                  limite_pct_pl: taxaMinima,
                  // estoque_rs = CDI vigente % a.a. (ex: 14.75)
                  estoque_rs: cdiVigente,
                  // proposto_rs = múltiplo CDI da regra (ex: 140)
                  proposto_rs: unidade === 'percentual_cdi' ? valorLimite : undefined,
                  // valor_extra = taxa apurada como % do CDI (ex: "251.0")
                  valor_extra: pctCdi != null ? pctCdi.toFixed(1) : undefined,
                  status: violou ? 'violacao' : 'ok',
                });
              }
              if (allTxs.length > 0) {
                const mn = Math.min(...allTxs); const mx = Math.max(...allTxs);
                va = mn === mx ? `${mn.toFixed(2)}% a.a. decl.` : `${mn.toFixed(2)}% — ${mx.toFixed(2)}% a.a. decl.`;
              } else {
                va = 'TX_CESSAO ausente ou zero';
              }
            }
          } else if (campo === 'taxa_cessao_implicita') {
            const cdiAa = resolveCdi(p, cdiSpotAa) / 100;
            const percentual = Number(p.valor_limite) || 140;
            if (cdiAa > 0) {
              const cdiDu = Math.pow(1 + cdiAa, 1 / 252) - 1;
              const taxaMinDu = (percentual / 100) * cdiDu;
              const taxaMinAa = Math.pow(1 + taxaMinDu, 252) - 1;
              vl = `≥ ${(taxaMinAa * 100).toFixed(2)}% a.a. implícita (${percentual}%×CDI ${(cdiAa * 100).toFixed(2)}%)`;
              const impls: number[] = [];
              for (const [cedenteDoc, grupo] of cedenteGroup) {
                if (grupo.total_aquisicao <= 0 || grupo.prazo_max <= 0) continue;
                const fvMinimo = grupo.total_aquisicao * Math.pow(1 + taxaMinDu, grupo.prazo_max);
                const taxaImpl = Math.pow(grupo.total_nominal / grupo.total_aquisicao, 252 / grupo.prazo_max) - 1;
                impls.push(taxaImpl);
                const nome = dcsAquisicao.find(d => cleanDoc(d.cpf_cnpj_cedente) === cedenteDoc)?.nm_cedente || cedenteDoc;
                bd.push({
                  tipo_item: 'cedente',
                  label: nome,
                  doc: cedenteDoc,
                  total_aquisicao: grupo.total_aquisicao,
                  valor_extra: `TX impl.: ${(taxaImpl * 100).toFixed(2)}% a.a. | FV ${grupo.total_nominal.toFixed(2)} vs. mín. ${fvMinimo.toFixed(2)}`,
                  status: grupo.total_nominal < fvMinimo ? 'violacao' : 'ok',
                });
              }
              if (impls.length) {
                const mn = Math.min(...impls); const mx = Math.max(...impls);
                va = impls.length === 1 ? `${(mn * 100).toFixed(2)}% a.a. impl.` : `${(mn * 100).toFixed(2)}% — ${(mx * 100).toFixed(2)}% a.a. impl.`;
              } else va = 'Sem base (TOTAL_AQUISICAO / PRAZO por cedente)';
            }
          } else if (campo === 'vencimento') {
            vl = 'Vencimento ≥ data da cessão';
            let bad = 0;
            for (const dc of dcsAquisicao) {
              if (!matchesTipoRecebivel(dc, p.filtro_tipo_recebivel)) continue;
              const violou = dc.dt_vencimento && dc.dt_entrada && new Date(dc.dt_vencimento).getTime() < new Date(dc.dt_entrada).getTime();
              if (violou) bad++;
              bd.push({
                tipo_item: 'dc',
                tipo_linha: 'titulo',
                origem: 'csv',
                label: dc.ds_seu_numero,
                doc: cleanDoc(dc.cpf_cnpj_cedente),
                documento: dc.ds_seu_numero || dc.ds_nu_documento || '',
                cedente: dc.nm_cedente || dc.cpf_cnpj_cedente || '—',
                sacado: dc.nm_sacado || dc.nu_cpf_cnpj_sacado || '—',
                prazo: dc.prazo,
                dt_vencimento: dc.dt_vencimento,
                total_aquisicao: dc.total_aquisicao || null,
                valor_extra: `Venc: ${dc.dt_vencimento ?? '—'}`,
                status: violou ? 'violacao' : 'ok',
              });
            }
            va = bad ? `${bad} título(s) vencido(s)` : 'Nenhum título vencido antes da cessão';
          } else if (campo === 'inadimplencia_cedente') {
            vl = `≤ ${valorLimite}d atraso (cedente)`;
            const vistosC = new Set<string>();
            let maxA = 0;
            for (const dc of dcsAquisicao) {
              const doc = cleanDoc(dc.cpf_cnpj_cedente);
              if (!doc || vistosC.has(doc)) continue;
              vistosC.add(doc);
              const atraso = cedenteInadimplenteDias.get(doc) ?? 0;
              maxA = Math.max(maxA, atraso);
              bd.push({
                tipo_item: 'cedente',
                label: dc.nm_cedente || doc,
                doc,
                valor_extra: `Maior atraso no estoque: ${atraso}d`,
                status: atraso > valorLimite ? 'violacao' : 'ok',
              });
            }
            va = `${maxA}d (maior atraso observado no estoque)`;
          } else if (campo === 'tipo_recebivel') {
            const filtro = p.filtro_tipo_recebivel;
            vl = Array.isArray(filtro) && filtro.length ? (filtro as string[]).join(', ') : '—';
            const ok = dcsAquisicao.filter(dc => matchesTipoRecebivel(dc, filtro)).length;
            va = `${ok} / ${dcsAquisicao.length} DCs com tipo permitido`;
            for (const dc of dcsAquisicao) {
              bd.push({
                tipo_item: 'dc',
                tipo_linha: 'titulo',
                origem: 'csv',
                label: dc.ds_seu_numero,
                doc: cleanDoc(dc.cpf_cnpj_cedente),
                documento: dc.ds_seu_numero || dc.ds_nu_documento || '',
                cedente: dc.nm_cedente || dc.cpf_cnpj_cedente || '—',
                sacado: dc.nm_sacado || dc.nu_cpf_cnpj_sacado || '—',
                prazo: dc.prazo,
                dt_vencimento: dc.dt_vencimento,
                total_aquisicao: dc.total_aquisicao || null,
                valor_extra: `Tipo: ${dc.nm_tipo_recebivel || '?'} | ${dc.nm_cedente} → ${dc.nm_sacado}`,
                status: matchesTipoRecebivel(dc, filtro) ? 'ok' : 'violacao',
              });
            }
          } else if (campo === 'exposicao_prazo_acima') {
            const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
            const diasRef = Number(p.dias_referencia) || 90;
            vl = `máx. ${(limitePl * 100).toFixed(2)}% PL (títulos >${diasRef} du)`;
            let maxP = 0;
            for (const dc of dcsAquisicao) {
              if (!matchesTipoRecebivel(dc, p.filtro_tipo_recebivel)) continue;
              if (dc.prazo <= diasRef) continue;
              const pctPl = pl > 0 ? dc.vl_pago / pl : 0;
              maxP = Math.max(maxP, pctPl);
              bd.push({
                tipo_item: 'dc',
                tipo_linha: 'titulo',
                origem: 'csv',
                label: dc.ds_seu_numero,
                doc: cleanDoc(dc.cpf_cnpj_cedente),
                documento: dc.ds_seu_numero || dc.ds_nu_documento || '',
                cedente: dc.nm_cedente || dc.cpf_cnpj_cedente || '—',
                sacado: dc.nm_sacado || dc.nu_cpf_cnpj_sacado || '—',
                prazo: dc.prazo,
                dt_vencimento: dc.dt_vencimento,
                total_aquisicao: dc.total_aquisicao || null,
                valor_extra: `Prazo ${dc.prazo}du, ${(pctPl * 100).toFixed(2)}% PL | ${dc.nm_cedente} → ${dc.nm_sacado}`,
                status: pctPl > limitePl ? 'violacao' : 'ok',
              });
            }
            va = pl > 0 ? `${(maxP * 100).toFixed(2)}% PL (maior título >${diasRef} du)` : 'PL indisponível';
          } else if (campo === 'substituicao_unica') {
            const tiposPermitidos: string[] =
              (p.tipos_permitidos as string[]) ??
              ['duplicata', 'ccb', 'nota comercial', 'cce'];
            vl = `máx. 1 recompra por título | tipos: ${tiposPermitidos.join(', ')} | não ativo no estoque`;

            const recomprasCsv = dcsRecompra;
            const total = recomprasCsv.length;
            const bloqueadas = recomprasCsv.filter(dc => {
              const docRef = (dc.ds_nu_documento || dc.ds_seu_numero || '').trim();
              const tipoNorm = (dc.nm_tipo_recebivel || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/\p{Diacritic}/gu, '');
              const tipoValido = tiposPermitidos.some(t =>
                tipoNorm.includes(t.toLowerCase()
                  .normalize('NFD')
                  .replace(/\p{Diacritic}/gu, '')),
              );
              const chave = `${docRef}|${cleanDoc(dc.cpf_cnpj_cedente)}`;
              const aindaAtivo = docRef !== '' && estoqueAtivoSet.has(chave);
              return !tipoValido
                || (docRef !== '' && recompraHistoricoSet.has(chave))
                || aindaAtivo;
            }).length;

            va = total === 0
              ? 'nenhuma recompra nesta cessão'
              : `${total} recompra(s) — ${bloqueadas} bloqueada(s)`;

            for (const dc of recomprasCsv) {
              const docRef = (dc.ds_nu_documento || dc.ds_seu_numero || '').trim();
              const chave = `${docRef}|${cleanDoc(dc.cpf_cnpj_cedente)}`;
              const jaRecomprado = docRef !== '' && recompraHistoricoSet.has(chave);
              const aindaAtivo = docRef !== '' && estoqueAtivoSet.has(chave);
              const tipoNorm = (dc.nm_tipo_recebivel || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/\p{Diacritic}/gu, '');
              const tipoValido = tiposPermitidos.some(t =>
                tipoNorm.includes(t.toLowerCase()
                  .normalize('NFD')
                  .replace(/\p{Diacritic}/gu, '')),
              );
              const violou = !tipoValido || jaRecomprado || aindaAtivo;
              bd.push({
                tipo_item: 'dc',
                tipo_linha: 'titulo',
                origem: 'csv',
                label: dc.ds_seu_numero || dc.ds_nu_documento || 'Sem documento',
                doc: cleanDoc(dc.cpf_cnpj_cedente),
                documento: dc.ds_seu_numero || dc.ds_nu_documento || '',
                cedente: dc.nm_cedente || dc.cpf_cnpj_cedente || '—',
                sacado: dc.nm_sacado || dc.nu_cpf_cnpj_sacado || '—',
                prazo: dc.prazo,
                dt_vencimento: dc.dt_vencimento,
                valor_rs: dc.vl_pago,
                valor_extra: violou
                  ? (!tipoValido ? 'tipo não permitido — BLOQUEADO'
                    : aindaAtivo ? 'ainda ativo no estoque — BLOQUEADO'
                    : jaRecomprado ? '2ª recompra — BLOQUEADO'
                    : 'bloqueado')
                  : '1ª recompra — elegível (liquidado/baixado)',
                status: violou ? 'violacao' : 'ok',
              });
            }
          }
        } else if (modo === 'proforma' || modo === 'concentracao') {
          if (campo === 'prazo_medio') {
            vl = `${operador} ${valorLimite} du (pró-forma)`;
            // Exclui vencidos do estoque (prazo_atual < 0) — só a carteira a vencer entra no prazo médio
            const totalVp = carteiraVPAVencer + proposedVpTotal;
            const totalPrazoSoma = carteiraPrazoSomaAVencer + proposedPrazoSoma;
            const pm = totalVp > 0 ? totalPrazoSoma / totalVp : 0;
            const pmEstoque = carteiraVPAVencer > 0 ? carteiraPrazoSomaAVencer / carteiraVPAVencer : 0;
            const pmCsv = proposedVpTotal > 0 ? proposedPrazoSoma / proposedVpTotal : 0;
            va = `${pm.toFixed(1)} du (carteira a vencer + cessão elegível)`;
            bd.push({
              tipo_item: 'dc',
              tipo_linha: 'resumo',
              origem: 'estoque',
              label: 'Estoque_FIDC (a vencer)',
              doc: '',
              estoque_rs: carteiraVPAVencer,
              proposto_rs: 0,
              total_rs: carteiraVPAVencer,
              valor_atual_texto: carteiraVPAVencer > 0 ? `${pmEstoque.toFixed(1)} du` : '—',
              limite_texto: vl,
              status: 'ok',
            });
            bd.push({
              tipo_item: 'dc',
              tipo_linha: 'resumo',
              origem: 'csv',
              label: 'CSV importado',
              doc: '',
              estoque_rs: 0,
              proposto_rs: proposedVpTotal,
              total_rs: proposedVpTotal,
              valor_atual_texto: proposedVpTotal > 0 ? `${pmCsv.toFixed(1)} du` : '—',
              limite_texto: vl,
              status: 'ok',
            });
            bd.push({
              tipo_item: 'dc',
              tipo_linha: 'resumo',
              origem: 'proforma',
              label: 'Pró-forma total',
              doc: '',
              estoque_rs: carteiraVPAVencer,
              proposto_rs: proposedVpTotal,
              total_rs: totalVp,
              valor_atual_texto: `${pm.toFixed(1)} du`,
              limite_texto: vl,
              status: opCompare(pm, operador, valorLimite) ? 'violacao' : 'ok',
            });
            // Detalhes: somente estoque a vencer
            for (const row of estoqueRows.filter(r => (Number(r.prazo_atual) || 0) >= 0)) {
              detalhesOrigem.push({
                tipo_item: 'dc',
                tipo_linha: 'titulo',
                origem: 'estoque',
                label: row.seu_numero || row.nu_documento || 'Sem documento',
                doc: cleanDoc(row.doc_cedente),
                documento: row.seu_numero || row.nu_documento || '',
                cedente: row.nome_cedente || row.doc_cedente || '—',
                sacado: row.nome_sacado || row.doc_sacado || '—',
                prazo: Number(row.prazo) || 0,
                dt_vencimento: row.data_vencimento_ajustada,
                total_aquisicao: null,
                valor_rs: Number(row.valor_nominal) || Number(row.valor_presente) || 0,
                status: 'ok',
              });
            }
            for (const idx of elegiveisIdx) {
              const dc = results[idx].dc;
              detalhesOrigem.push({
                tipo_item: 'dc',
                tipo_linha: 'titulo',
                origem: 'csv',
                label: dc.ds_seu_numero || dc.ds_nu_documento || 'Sem documento',
                doc: cleanDoc(dc.cpf_cnpj_cedente),
                documento: dc.ds_seu_numero || dc.ds_nu_documento || '',
                cedente: dc.nm_cedente || dc.cpf_cnpj_cedente || '—',
                sacado: dc.nm_sacado || dc.nu_cpf_cnpj_sacado || '—',
                prazo: dc.prazo,
                dt_vencimento: dc.dt_vencimento,
                total_aquisicao: dc.total_aquisicao || null,
                valor_rs: dc.vl_pago,
                status: 'ok',
              });
            }
          } else if (campo === 'sem_coobrigacao') {
            const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
            vl = `máx. ${(limitePl * 100).toFixed(2)}% do PL`;
            if (pl > 0) {
              const totalSemCoobrigacao = estoqueSemCoobrigacaoTotal + proposedSemCoobrigacao;
              va = `${((totalSemCoobrigacao / pl) * 100).toFixed(2)}% do PL`;
            }
          } else if (campo === 'concentracao_cedente') {
            const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
            vl = `máx. ${(limitePl * 100).toFixed(2)}% do PL (cedente/grupo)`;
            // Agrupa por grupo econômico — empresas do mesmo grupo são consolidadas
            const usarPddCC = p.usar_abatimento_pdd !== false;
            if (pl > 0) {
              const allCedentesGrupo2 = new Map<string, string>();
              for (const dc of dcs) {
                const doc = cleanDoc(dc.cpf_cnpj_cedente);
                if (!doc) continue;
                const g = resolverGrupo(doc, dc.nm_cedente, grupoEconomicoMap);
                if (!allCedentesGrupo2.has(g.chave)) allCedentesGrupo2.set(g.chave, g.nomeGrupo);
              }
              let maxPct = 0;
              for (const [chave, nome] of allCedentesGrupo2) {
                const estoqueExp = usarPddCC
                  ? (estoqueByCedenteGrupoLiq.get(chave) ?? 0)
                  : (estoqueByCedenteGrupo.get(chave) ?? 0);
                const proposedExp = proposedByCedenteGrupo.get(chave) ?? 0;
                const totalExp = exposicaoProforma(estoqueExp, proposedExp, recompraByCedenteGrupo.get(chave) ?? 0);
                const pctPl = totalExp / pl;
                maxPct = Math.max(maxPct, pctPl);
                const isGrupo = nomeDeGrupoCedente(chave) !== chave || grupoEconomicoMap.size > 0;
                bd.push({ tipo_item: 'cedente', label: isGrupo && nome !== chave ? `${nome} ★` : nome, doc: chave, estoque_rs: estoqueExp, proposto_rs: proposedExp, total_rs: totalExp, pct_pl: pctPl * 100, limite_pct_pl: limitePl * 100, status: pctPl > limitePl ? 'violacao' : 'ok' });
              }
              bd.sort((a, b) => (b.pct_pl ?? 0) - (a.pct_pl ?? 0));
              va = `${(maxPct * 100).toFixed(2)}% do PL (pior cedente/grupo)`;
            }
          } else if (campo === 'concentracao_devedor') {
            const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
            vl = `máx. ${(limitePl * 100).toFixed(2)}% do PL (sacado/grupo)`;
            const usarPddCD = p.usar_abatimento_pdd !== false;
            if (pl > 0) {
              const allSacadosGrupo2 = new Map<string, string>();
              for (const dc of dcs) {
                const doc = cleanDoc(dc.nu_cpf_cnpj_sacado);
                if (!doc) continue;
                const g = resolverGrupo(doc, dc.nm_sacado, grupoEconomicoMap);
                if (!allSacadosGrupo2.has(g.chave)) allSacadosGrupo2.set(g.chave, g.nomeGrupo);
              }
              let maxPct = 0;
              for (const [chave, nome] of allSacadosGrupo2) {
                const estoqueExp = usarPddCD
                  ? (estoqueBySacadoGrupoLiq.get(chave) ?? 0)
                  : (estoqueBySacadoGrupo.get(chave) ?? 0);
                const proposedExp = proposedBySacadoGrupo.get(chave) ?? 0;
                const totalExp = exposicaoProforma(estoqueExp, proposedExp, recompraBySacadoGrupo.get(chave) ?? 0);
                const pctPl = totalExp / pl;
                maxPct = Math.max(maxPct, pctPl);
                bd.push({ tipo_item: 'sacado', label: nome !== chave ? `${nome} ★` : nome, doc: chave, estoque_rs: estoqueExp, proposto_rs: proposedExp, total_rs: totalExp, pct_pl: pctPl * 100, limite_pct_pl: limitePl * 100, status: pctPl > limitePl ? 'violacao' : 'ok' });
              }
              bd.sort((a, b) => (b.pct_pl ?? 0) - (a.pct_pl ?? 0));
              va = `${(maxPct * 100).toFixed(2)}% do PL (pior sacado/grupo)`;
            }
          } else if (campo === 'taxa_cessao' && modo === 'proforma') {
            const cdiVigente = resolveCdi(p, cdiSpotAa);
            let taxaMinima = valorLimite;
            if (unidade === 'percentual_cdi' && cdiVigente > 0) {
              taxaMinima = cdiVigente * (valorLimite / 100);
              vl = `≥ ${taxaMinima.toFixed(2)}% a.a. média (${valorLimite}%×CDI)`;
            }
            const estoqueVpAVencer = estoqueRows.filter(r => (Number(r.prazo_atual) || 0) >= 0).reduce((s, r) => s + (Number(r.valor_presente) || 0), 0);
            const totalVpProforma = estoqueVpAVencer + proposedVpTotal;
            if (totalVpProforma > 0 && proposedVpTotal > 0) {
              const taxaMedia = elegiveisIdx.reduce((s, idx) => s + normalizeTaxaAnualDeclarada(results[idx].dc.tx_cessao || results[idx].dc.tx_juro) * results[idx].dc.vl_pago, 0) / proposedVpTotal;
              va = `${taxaMedia.toFixed(2)}% a.a. média ponderada (cessão elegível)`;
            }
          } else if (campo === 'exposicao_prazo_acima') {
            const limitePl = unidade === 'percentual_pl' ? valorLimite / 100 : valorLimite;
            const diasRef = Number(p.dias_referencia) || 90;
            const filtro = p.filtro_tipo_recebivel;
            const filtroLabel = Array.isArray(filtro) && filtro.length ? filtro.join('/') : 'todos';
            vl = `máx. ${(limitePl * 100).toFixed(2)}% PL (${filtroLabel} prazo >${diasRef}du)`;
            if (pl > 0) {
              // Estoque: títulos com prazo_atual > diasRef E tipo_recebivel correspondente ao filtro
              const estoqueMatchRows = estoqueRows.filter(r => (Number(r.prazo_atual) || 0) > diasRef && matchesTipoRecebivelEstoque(r, filtro));
              const estoqueExpPrazo = estoqueMatchRows.reduce((s, r) => s + (Number(r.valor_nominal) || Number(r.valor_presente) || 0), 0);
              // CSV elegível: apenas tipo + prazo correspondentes
              const proposedMatchIdx = elegiveisIdx.filter(idx => matchesTipoRecebivel(results[idx].dc, filtro) && results[idx].dc.prazo > diasRef);
              const proposedExpPrazo = proposedMatchIdx.reduce((s, idx) => s + results[idx].dc.vl_pago, 0);
              const totalExpPrazo = estoqueExpPrazo + proposedExpPrazo;
              const pctPl = totalExpPrazo / pl;
              va = `${(pctPl * 100).toFixed(2)}% PL (${filtroLabel} prazo >${diasRef}du, estoque+cessão)`;
              violacaoPercentualCessao = pctPl > limitePl;
              bd.push({
                tipo_item: 'dc',
                tipo_linha: 'resumo',
                origem: 'estoque',
                label: `Estoque_FIDC (${filtroLabel}, prazo >${diasRef}du)`,
                doc: '',
                estoque_rs: estoqueExpPrazo,
                proposto_rs: 0,
                total_rs: estoqueExpPrazo,
                pct_pl: (estoqueExpPrazo / pl) * 100,
                limite_pct_pl: limitePl * 100,
                status: 'ok',
              });
              bd.push({
                tipo_item: 'dc',
                tipo_linha: 'resumo',
                origem: 'csv',
                label: `CSV importado (${filtroLabel}, prazo >${diasRef}du)`,
                doc: '',
                estoque_rs: 0,
                proposto_rs: proposedExpPrazo,
                total_rs: proposedExpPrazo,
                pct_pl: (proposedExpPrazo / pl) * 100,
                limite_pct_pl: limitePl * 100,
                status: 'ok',
              });
              bd.push({
                tipo_item: 'dc',
                tipo_linha: 'resumo',
                origem: 'proforma',
                label: 'Pró-forma total',
                doc: '',
                estoque_rs: estoqueExpPrazo,
                proposto_rs: proposedExpPrazo,
                total_rs: totalExpPrazo,
                pct_pl: pctPl * 100,
                limite_pct_pl: limitePl * 100,
                status: pctPl > limitePl ? 'violacao' : 'ok',
              });
              // Detalhes: DCs do CSV que contribuem para o cálculo
              for (const idx of proposedMatchIdx) {
                const dc = results[idx].dc;
                bd.push({
                  tipo_item: 'dc',
                  tipo_linha: 'titulo',
                  origem: 'csv',
                  label: dc.ds_seu_numero || dc.ds_nu_documento || 'Sem documento',
                  doc: cleanDoc(dc.cpf_cnpj_cedente) || '',
                  documento: dc.ds_seu_numero || dc.ds_nu_documento || '',
                  cedente: dc.nm_cedente || dc.cpf_cnpj_cedente || '—',
                  sacado: dc.nm_sacado || dc.nu_cpf_cnpj_sacado || '—',
                  prazo: dc.prazo,
                  dt_vencimento: dc.dt_vencimento,
                  total_aquisicao: dc.total_aquisicao || null,
                  valor_extra: `Prazo ${dc.prazo}du, ${(dc.vl_pago / pl * 100).toFixed(2)}% PL individual`,
                  status: pctPl > limitePl ? 'violacao' : 'ok',
                });
              }
            } else {
              va = 'PL indisponível';
            }
          }
        }
      }

      checklistSnapshot.set(rule.codigo, { valor_atual: va, valor_limite: vl, breakdown: bd, detalhes_origem: detalhesOrigem, violacao_percentual: violacaoPercentualCessao });
    }

    // ── 9. Calcular métricas ──────────────────────────────────────────
    // KPIs de elegibilidade excluem recompras — apenas aquisições são avaliadas.
    const totalDcs = dcsAquisicao.length;
    const vpTotalProposto = dcsAquisicao.reduce((s, d) => s + d.vl_pago, 0);
    const totalRecompras = dcsRecompra.length;
    const vpRecompras = dcsRecompra.reduce((s, d) => s + d.vl_pago, 0);
    const elegiveisList = results.filter(r => r.elegivel === true);
    const inelegiveisList = results.filter(r => r.elegivel === false);
    const enquadramList = results.filter(r => r.enquadra === true);
    const desenquadramList = results.filter(r => r.elegivel === true && r.enquadra === false);
    const vpElegiveis = elegiveisList.reduce((s, r) => s + r.dc.vl_pago, 0);
    const vpEnquadram = enquadramList.reduce((s, r) => s + r.dc.vl_pago, 0);

    const proformaVP = carteiraVP + vpEnquadram;
    const proformaPercPl = pl > 0 ? proformaVP / pl : 0;
    const proformaPrazoSoma = carteiraPrazoSoma +
      enquadramList.reduce((s, r) => s + r.dc.prazo * r.dc.vl_pago, 0);
    const proformaPrazoMedio = proformaVP > 0 ? proformaPrazoSoma / proformaVP : 0;
    const espacoLivre = pl > 0 ? Math.max(0, pl - proformaVP) : 0;

    // Motivos de rejeição agregados + detalhes por regra para checklist
    const motivosSummary = new Map<string, { regra_codigo: string; regra_descricao: string; count: number }>();
    // Collect per-rule detail: which DCs were rejected and why
    const regraDetalhes = new Map<string, { valor_atual: string | null; valor_limite: string | null; dcs: { ds_seu_numero: string; nm_sacado: string; nm_cedente: string; vl_pago: number; prazo: number; valor_atual: any; valor_limite: any }[] }>();

    for (const r of [...results, ...recompraResults]) {
      for (const m of r.motivos) {
        const existing = motivosSummary.get(m.regra_codigo);
        if (existing) existing.count++;
        else motivosSummary.set(m.regra_codigo, { regra_codigo: m.regra_codigo, regra_descricao: m.regra_descricao, count: 1 });

        if (!regraDetalhes.has(m.regra_codigo)) {
          regraDetalhes.set(m.regra_codigo, { valor_atual: null, valor_limite: null, dcs: [] });
        }
        const det = regraDetalhes.get(m.regra_codigo)!;
        // Keep the first non-null valor_atual/valor_limite as representative
        if (det.valor_atual === null && m.valor_atual != null) det.valor_atual = String(m.valor_atual);
        if (det.valor_limite === null && m.valor_limite != null) det.valor_limite = String(m.valor_limite);
        det.dcs.push({
          ds_seu_numero: r.dc.ds_seu_numero,
          nm_sacado: r.dc.nm_sacado,
          nm_cedente: r.dc.nm_cedente,
          vl_pago: r.dc.vl_pago,
          prazo: r.dc.prazo,
          valor_atual: m.valor_atual,
          valor_limite: m.valor_limite,
        });
      }
    }

    const carteiraSnapshot = {
      qtd_recebiveis: carteiraQtd,
      vp_total: carteiraVP,
      pdd_total: carteiraPDD,
      prazo_medio_pond: Math.round(carteiraPrazoMedio * 100) / 100,
      perc_pl_alocado: Math.round(percPlAlocado * 10000) / 100,
      /** Patrimônio líquido considerado (FIDC: valorativos + valorreceber; demais: fundo_patliq) */
      pl,
      pl_header_raw: plHeaderRaw,
      pl_origem: plOrigem,
      /** Data da posição (fundo_dtposicao, tipicamente YYYYMMDD) */
      pl_data_posicao: plDataPosicao,
      /** Data de referência do estoque (reference_date de importacoes_estoque_fidc) */
      estoque_data_referencia: matchImport?.reference_date ?? null,
    };

    const proformaSnapshot = {
      vp_total: proformaVP,
      perc_pl: Math.round(proformaPercPl * 10000) / 100,
      prazo_medio_pond: Math.round(proformaPrazoMedio * 100) / 100,
      espaco_livre: espacoLivre,
    };

    // ── 10. Persistir ─────────────────────────────────────────────────
    const importId = crypto.randomUUID();

    const regrasChecklist = rules.map(rule => {
      const snap = checklistSnapshot.get(rule.codigo);
      let rejeicoes = motivosSummary.get(rule.codigo)?.count || 0;
      let detalhesDcs: unknown[] = [];
      let submotivosCadastro: { codigo: string; descricao: string; count: number }[] = [];
      let valorAtual: string | null = null;
      let valorLimite: string | null = null;

      if (rule.tipo_regra === 'CESSAO_CADASTRO_PARTES') {
        rejeicoes = 0;
        for (const [cod, val] of motivosSummary) {
          if (cod.startsWith('CADASTRO_') || cod === 'LIMITE_COMITE_EXCEDIDO') {
            rejeicoes += val.count;
          }
        }
        const cadAgg = aggregateCadastroMotivos(motivosSummary, regraDetalhes);
        submotivosCadastro = cadAgg.submotivos;
        detalhesDcs = cadAgg.dcs;
        valorAtual = snap?.valor_atual ?? cadAgg.valorAtual;
        valorLimite = snap?.valor_limite ?? cadAgg.valorLimite;
      } else {
        const det = regraDetalhes.get(rule.codigo);
        detalhesDcs = det?.dcs ?? [];
        valorAtual = det?.valor_atual ?? snap?.valor_atual ?? null;
        const p = rule.parametros;
        const limiteLegado =
          p.valor_limite != null
            ? String(p.valor_limite)
            : p.limite_max != null
              ? `${(Number(p.limite_max) * 100).toFixed(2)}% do PL`
              : null;
        valorLimite = det?.valor_limite ?? snap?.valor_limite ?? limiteLegado;
      }

      const p = rule.parametros;
      const limiteLegadoFallback =
        p.valor_limite != null
          ? String(p.valor_limite)
          : p.limite_max != null
            ? `${(Number(p.limite_max) * 100).toFixed(2)}% do PL`
            : null;
      if (valorLimite == null) valorLimite = limiteLegadoFallback;

      const modo =
        rule.tipo_regra === 'CESSAO_CADASTRO_PARTES'
          ? 'cadastro'
          : (p.modo as string) || (rule.tipo_regra.startsWith('CONCENTRACAO_') ? 'concentracao' : 'individual');
      return {
        regra_codigo: rule.codigo,
        regra_descricao:
          rule.tipo_regra === 'CESSAO_CADASTRO_PARTES'
            ? descricaoRegraCadastroPartes(rule.descricao)
            : rule.descricao,
        modo,
        rejeicoes,
        total_dcs: totalDcs, // somente aquisições
        status: rejeicoes > 0 || snap?.violacao_percentual === true ? 'violacao' : 'ok',
        valor_atual: valorAtual,
        valor_limite: valorLimite,
        detalhes_dcs: detalhesDcs,
        submotivos_cadastro: submotivosCadastro,
        breakdown: snap?.breakdown ?? [],
        detalhes_origem: snap?.detalhes_origem ?? [],
      };
    });

    const limiteComiteSnap = checklistSnapshot.get('LIMITE_COMITE_PARTES');
    if (cadastroRule && limiteComiteSnap) {
      const rejLimite = motivosSummary.get('LIMITE_COMITE_EXCEDIDO')?.count ?? 0;
      regrasChecklist.push({
        regra_codigo: 'LIMITE_COMITE_PARTES',
        regra_descricao: 'Limite R$ de comitê por cedente/grupo (pró-forma)',
        modo: 'proforma',
        rejeicoes: rejLimite,
        total_dcs: totalDcs,
        status: rejLimite > 0 || limiteComiteSnap.violacao_percentual === true ? 'violacao' : 'ok',
        valor_atual: limiteComiteSnap.valor_atual,
        valor_limite: limiteComiteSnap.valor_limite,
        detalhes_dcs: [],
        breakdown: limiteComiteSnap.breakdown ?? [],
        detalhes_origem: [],
      });
    }

    const { error: impError } = await supabase.from('cessao_importacoes').insert({
      id: importId,
      fundo_cnpj: fundoCnpj,
      fundo_nome: fundoNome,
      data_cessao: dataCessao,
      filename: file.name,
      total_dcs: totalDcs,
      elegiveis: elegiveisList.length,
      inelegiveis: inelegiveisList.length,
      enquadram: enquadramList.length,
      desenquadram: desenquadramList.length,
      vp_total_proposto: vpTotalProposto,
      vp_elegiveis: vpElegiveis,
      total_recompras: totalRecompras,
      vp_recompras: vpRecompras,
      status: 'success',
      carteira_snapshot: carteiraSnapshot,
      proforma_snapshot: proformaSnapshot,
      regras_snapshot: regrasChecklist,
    });

    if (impError) throw new Error(`Erro ao salvar importação: ${impError.message}`);

    const toRecord = (r: DcResult) => ({
      import_id: importId,
      nm_fundo: r.dc.nm_fundo,
      cnpj_fundo: fundoCnpj,
      nm_cedente: r.dc.nm_cedente,
      cpf_cnpj_cedente: r.dc.cpf_cnpj_cedente,
      nm_sacado: r.dc.nm_sacado,
      nu_cpf_cnpj_sacado: r.dc.nu_cpf_cnpj_sacado,
      nm_tipo_recebivel: r.dc.nm_tipo_recebivel,
      ds_seu_numero: r.dc.ds_seu_numero,
      ds_nu_documento: r.dc.ds_nu_documento,
      vl_pago: r.dc.vl_pago,
      vl_nominal: r.dc.vl_nominal,
      prazo: r.dc.prazo,
      tx_juro: r.dc.tx_juro,
      tx_cessao: r.dc.tx_cessao,
      dt_vencimento: r.dc.dt_vencimento,
      dt_entrada: r.dc.dt_entrada,
      chave_nfe: r.dc.chave_nfe,
      elegivel: r.elegivel,
      enquadra: r.enquadra,
      motivos_rejeicao: r.motivos,
      tipo_operacao: r.dc.tipo_operacao,
    });

    // Aquisições: motor de elegibilidade | Recompras: regra 6.2(f) quando associada
    const records = [...results, ...recompraResults].map(toRecord);

    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const { error } = await supabase.from('cessao_resultado_analitico').insert(batch);
      if (error) throw new Error(`Erro ao salvar resultados: ${error.message}`);
    }

    // ── 11. Response ──────────────────────────────────────────────────
    // Debug compacto incluído no log final para diagnóstico de isRecompra
    const _debugSummary = _debugRecompra.map((d: any) =>
      `${d.doc}|prazo=${d.prazo}(${d.criPrazo})|txJ=${d.tx_juro}(${d.criTaxaJ})|txC=${d.tx_cessao}|chave="${d.chave_nfe}"(${d.criChave})|=>det=${d.detected}`
    ).join(' ;; ');
    console.log(`[validar-cessao] OK: ${enquadramList.length} enquadram, ${desenquadramList.length} desenquadram, ${inelegiveisList.length} inelegíveis, ${totalRecompras} recompras | DEBUG_ISRECOMPRA: ${_debugSummary}`);

    return new Response(
      JSON.stringify({
        success: true,
        import_id: importId,
        fundo_cnpj: fundoCnpj,
        fundo_nome: fundoNome,
        fundo_isin_resolvido: fundoIsinUsado || null,
        data_cessao: dataCessao,
        regras_aplicadas: rules.length,
        cdi_vigente: {
          valor_aa: cdiSpotAa,
          fonte: cdiSpotResult.fonte,
          ...(cdiSpotResult.erro ? { erro: cdiSpotResult.erro, fallback: true } : {}),
        },
        carteira_atual: carteiraSnapshot,
        cessao_proposta: {
          total_dcs: totalDcs,
          vp_total_proposto: vpTotalProposto,
          elegiveis: elegiveisList.length,
          inelegiveis: inelegiveisList.length,
          enquadram: enquadramList.length,
          desenquadram: desenquadramList.length,
          vp_elegiveis: vpElegiveis,
        },
        recompras: {
          total: totalRecompras,
          vp: vpRecompras,
        },
        _debug_recompra: _debugRecompra,
        proforma: proformaSnapshot,
        motivos_rejeicao: [...motivosSummary.values()],
        regras_checklist: regrasChecklist,
        coobrigacao_cedentes: coobrigacaoCedentes,
        resultados: [...results, ...recompraResults].map(r => ({
          ds_seu_numero: r.dc.ds_seu_numero,
          nm_cedente: r.dc.nm_cedente,
          cpf_cnpj_cedente: r.dc.cpf_cnpj_cedente,
          nm_sacado: r.dc.nm_sacado,
          vl_pago: r.dc.vl_pago,
          prazo: r.dc.prazo,
          tipo_operacao: r.dc.tipo_operacao,
          elegivel: r.elegivel,
          enquadra: r.enquadra,
          motivos: r.motivos,
        })),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[validar-cessao-elegibilidade] erro:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
