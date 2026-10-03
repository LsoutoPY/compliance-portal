/**
 * Edge Function: import-resgates-movimentacoes
 *
 * Importa histórico de resgates a partir de planilhas passivo.relatório.movimentações (XLSX).
 * Calcula dias_ate_pagamento (dias úteis) e vertice (mapeamento ANBIMA).
 * Resolve codigo_clt via De-Para (passivo_cotista_de_para), igual ao import-passivo-fundos.
 *
 * Colunas da planilha:
 *   A=0 Cliente (cotista real, ex: "XP INVESTIMENTOS CORRETORA DE CA- P/C 495631")
 *   D=3 Contato (distribuidor/intermediário, ex: "QUADRANTE.XP")
 *   E=4 Fundo
 *   H=7 CNPJ do fundo
 *   J=9 Data boleta
 *   K=10 Data operação
 *   M=12 Data impacto
 *   P=15 Tipo movimento
 *   Q=16 Valor
 *
 * Request: multipart/form-data
 *   - file: arquivo XLSX
 *   - data_referencia: YYYYMMDD (data de referência para cálculo)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ─── Utilitários numéricos / data ─────────────────────────────────────────────

function parseValorBrasil(v: string | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number' && !isNaN(v)) return v >= 1e9 ? v / 100 : v;
  const s = String(v).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n >= 1e9 ? n / 100 : n;
}

/** Converte DD/MM/YYYY, DD-MM-YYYY ou série Excel em Date */
function parseDataBR(val: unknown): Date | null {
  if (val == null) return null;
  if (typeof val === 'number' && val > 0) {
    return new Date((val - 25569) * 86400 * 1000);
  }
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const y = parseInt(m[3], 10);
    const date = new Date(y, mo, d);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Dias úteis entre duas datas (exclui fins de semana) */
function diasUteisEntre(d1: Date, d2: Date): number {
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
  const start = d1 < d2 ? d1 : d2;
  const end   = d1 < d2 ? d2 : d1;
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return d1 <= d2 ? count : -count;
}

/** Mapeia dias até pagamento para vértice ANBIMA */
function diasParaVertice(dias: number | null): number | null {
  if (dias == null || dias < 0) return null;
  if (dias >= 182) return 504;
  if (dias >= 181) return 365;
  if (dias >= 123) return 180;
  if (dias >= 63)  return 122;
  if (dias >= 42)  return 63;
  if (dias >= 23)  return 42;
  if (dias >= 10)  return 21;
  if (dias >= 5)   return 10;
  if (dias >= 4)   return 5;
  if (dias >= 3)   return 4;
  if (dias >= 2)   return 3;
  if (dias > 1)    return 2;
  return 1;
}

function detectSource(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('passivo') && lower.includes('movimenta')) return 'passivo_movimentacoes';
  return 'passivo_movimentacoes';
}

// ─── De-Para: idêntico ao import-passivo-fundos ───────────────────────────────

interface DeParaLookup {
  exactMap: Map<string, number>;
  nomeEntries: Array<{ normalized: string; compact: string; codigo: number }>;
}

function normalizeContaNumero(val: string | null | undefined): string | null {
  if (!val) return null;
  const digits = String(val).replace(/\D/g, '');
  if (!digits) return null;
  const withoutLeadingZeros = digits.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

function normalizeNomeForMatch(name: string): string {
  return (name || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/["'`´]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactNome(name: string): string {
  return normalizeNomeForMatch(name).replace(/\s+/g, '');
}

function tokenizeNome(name: string): string[] {
  const stopWords = new Set([
    'DE', 'DO', 'DA', 'DOS', 'DAS', 'E', 'EM', 'NO', 'NA', 'PARA', 'COM',
    'CORRETORA', 'INVESTIMENTOS', 'BANCO', 'DTVM', 'CTVM', 'S', 'A', 'SA',
  ]);
  return normalizeNomeForMatch(name)
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stopWords.has(w));
}

function nomeSimilarity(a: string, b: string): number {
  const aCompact = compactNome(a);
  const bCompact = compactNome(b);
  if (!aCompact || !bCompact) return 0;
  if (aCompact === bCompact) return 1;
  if (aCompact.length >= 6 && bCompact.includes(aCompact)) return 0.92;
  if (bCompact.length >= 6 && aCompact.includes(bCompact)) return 0.92;
  const tokA = tokenizeNome(a);
  const tokB = tokenizeNome(b);
  if (tokA.length === 0 || tokB.length === 0) return 0;
  let overlap = 0;
  for (const t of tokA) {
    if (tokB.includes(t)) { overlap++; continue; }
    for (const tb of tokB) {
      if (tb.startsWith(t) || t.startsWith(tb)) { overlap += 0.7; break; }
    }
  }
  return overlap / Math.min(tokA.length, tokB.length);
}

/** Extrai CPF/CNPJ embutido: "NOME ( 068.556.108-97 )" */
function extractCpfCnpjFromCotista(cotista: string): string | null {
  if (!cotista) return null;
  const match = cotista.match(/\(\s*([\d]{3}\.[\d]{3}\.[\d]{3}-[\d]{2}|[\d]{2}\.[\d]{3}\.[\d]{3}\/[\d]{4}-[\d]{2})\s*\)/);
  if (match) return match[1].replace(/\D/g, '');
  return null;
}

/** Extrai número de conta: P/C, C/C, CC ou dígitos finais */
function extractContaFromCotista(cotista: string): string | null {
  if (!cotista) return null;
  const s = String(cotista).trim();
  let match = s.match(/P\/C\s*(\d+)/i) || s.match(/P\/C(\d+)/i);
  if (match) return normalizeContaNumero(match[1]);
  match = s.match(/C\/C\s*(\d+)/i) || s.match(/C\/C(\d+)/i);
  if (match) return normalizeContaNumero(match[1]);
  match = s.match(/\bCC\s*(\d+)/i);
  if (match) return normalizeContaNumero(match[1]);
  match = s.match(/(\d{6,})$/);
  if (match) return normalizeContaNumero(match[1]);
  return null;
}

async function buildDeParaLookup(): Promise<DeParaLookup> {
  const { data } = await supabase
    .from('passivo_cotista_de_para')
    .select('codigo_cliente, nome_cliente, conta_xp, conta_btg, cpf_cnpj');

  const exactMap = new Map<string, number>();
  const nomeEntries: Array<{ normalized: string; compact: string; codigo: number }> = [];

  for (const row of (data || []) as {
    codigo_cliente: number;
    nome_cliente: string | null;
    conta_xp: string | null;
    conta_btg: string | null;
    cpf_cnpj: string | null;
  }[]) {
    const contaXp = normalizeContaNumero(row.conta_xp);
    if (contaXp) exactMap.set('xp:' + contaXp, row.codigo_cliente);

    const contaBtg = normalizeContaNumero(row.conta_btg);
    if (contaBtg) exactMap.set('btg:' + contaBtg, row.codigo_cliente);

    const cpfCnpj = row.cpf_cnpj ? String(row.cpf_cnpj).replace(/\D/g, '') : null;
    if (cpfCnpj && cpfCnpj.length >= 11) exactMap.set('cpf:' + cpfCnpj, row.codigo_cliente);

    if (row.nome_cliente && String(row.nome_cliente).trim()) {
      const normalized = normalizeNomeForMatch(row.nome_cliente);
      const compact = compactNome(row.nome_cliente);
      if (normalized && !exactMap.has('nome:' + normalized)) {
        exactMap.set('nome:' + normalized, row.codigo_cliente);
      }
      if (normalized && compact) {
        nomeEntries.push({ normalized, compact, codigo: row.codigo_cliente });
      }
    }
  }
  return { exactMap, nomeEntries };
}

function resolveCodigoClt(cotista: string, deParaLookup: DeParaLookup): number | null {
  if (!cotista) return null;
  const { exactMap, nomeEntries } = deParaLookup;

  // 1) Conta extraída (P/C, C/C, CC ou dígitos no final)
  const conta = extractContaFromCotista(cotista);
  if (conta) {
    const byXp = exactMap.get('xp:' + conta);
    if (byXp) return byXp;
    const byBtg = exactMap.get('btg:' + conta);
    if (byBtg) return byBtg;
  }

  // 2) CPF/CNPJ embutido no nome
  const cpfCnpj = extractCpfCnpjFromCotista(cotista);
  if (cpfCnpj) {
    const byCpf = exactMap.get('cpf:' + cpfCnpj);
    if (byCpf) return byCpf;
  }

  // 3) Nome exato normalizado
  const normalizedCotista = normalizeNomeForMatch(cotista);
  const byNome = exactMap.get('nome:' + normalizedCotista);
  if (byNome) return byNome;

  // 4) Número de conta puro (BTG)
  const contaDireta = normalizeContaNumero(cotista);
  if (contaDireta) {
    const byBtgDireta = exactMap.get('btg:' + contaDireta);
    if (byBtgDireta) return byBtgDireta;
  }

  // 5) Fuzzy nome
  let bestCodigo: number | null = null;
  let bestScore = 0;
  let secondBest = 0;
  for (const entry of nomeEntries) {
    const score = nomeSimilarity(normalizedCotista, entry.normalized);
    if (score > bestScore) {
      secondBest = bestScore;
      bestScore = score;
      bestCodigo = entry.codigo;
    } else if (score > secondBest) {
      secondBest = score;
    }
  }
  if (bestCodigo != null && bestScore >= 0.78 && (bestScore - secondBest) >= 0.06) {
    return bestCodigo;
  }
  return null;
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface ResgateRow {
  fonte: string;
  fundo: string;
  fundo_cnpj: string | null;
  cotista: string;
  contato: string | null;
  codigo_clt: number | null;
  valor: number;
  data_impacto: string;
  data_operacao: string | null;
  data_boleta: string | null;
  tipo_movimento: string | null;
  dias_ate_pagamento: number | null;
  vertice: number | null;
}

type ImportMode = 'incremental' | 'substituir_periodo';

// ─── Parse da planilha ────────────────────────────────────────────────────────

/**
 * Colunas:
 *   A=0  Cliente  → cotista (nome real do investidor)
 *   D=3  Contato  → contato (distribuidor, ex: QUADRANTE.XP)
 *   E=4  Fundo
 *   H=7  CNPJ fundo
 *   J=9  Data boleta
 *   K=10 Data operação
 *   M=12 Data impacto
 *   P=15 Tipo movimento
 *   Q=16 Valor
 */
function parseMovimentacoesXlsx(
  buffer: ArrayBuffer,
  filename: string,
  dataReferenciaStr: string,
  deParaLookup: DeParaLookup,
): ResgateRow[] {
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const dataRef = parseDataBR(dataReferenciaStr.replace(/(\d{4})(\d{2})(\d{2})/, '$3/$2/$1'));
  if (!dataRef || isNaN(dataRef.getTime())) {
    console.warn('[import-resgates] data_referencia inválida:', dataReferenciaStr);
    return [];
  }

  // Localiza linha de cabeçalho pela coluna M ("Data impacto")
  let headerRow = 0;
  for (let r = 0; r <= Math.min(range.e.r, 5); r++) {
    const cellM = ws[XLSX.utils.encode_cell({ r, c: 12 })];
    const v = String(cellM?.v ?? '').toLowerCase();
    if (v.includes('data') && v.includes('impacto')) {
      headerRow = r;
      break;
    }
  }

  const rows: ResgateRow[] = [];
  const fonte = detectSource(filename);

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const colA = ws[XLSX.utils.encode_cell({ r, c: 0 })]?.v;   // Cliente (cotista real)
    const colD = ws[XLSX.utils.encode_cell({ r, c: 3 })]?.v;   // Contato (distribuidor)
    const colE = ws[XLSX.utils.encode_cell({ r, c: 4 })]?.v;   // Fundo
    const colH = ws[XLSX.utils.encode_cell({ r, c: 7 })]?.v;   // CNPJ fundo
    const colJ = ws[XLSX.utils.encode_cell({ r, c: 9 })]?.v;   // Data boleta
    const colK = ws[XLSX.utils.encode_cell({ r, c: 10 })]?.v;  // Data operação
    const colM = ws[XLSX.utils.encode_cell({ r, c: 12 })]?.v;  // Data impacto
    const colP = ws[XLSX.utils.encode_cell({ r, c: 15 })]?.v;  // Tipo movimento
    const colQ = ws[XLSX.utils.encode_cell({ r, c: 16 })]?.v;  // Valor

    const tipoMovimento = String(colP ?? '').trim().toUpperCase();
    if (!tipoMovimento.includes('RESGATE')) continue;

    const fundo   = String(colE ?? '').trim();
    // colA = Cliente (investidor real); colD = Contato (distribuidor)
    const cotista = String(colA ?? colD ?? '').trim();
    const contato = colD ? String(colD).trim() || null : null;
    const valor   = parseValorBrasil(colQ);
    if (!fundo || !cotista || valor <= 0) continue;

    const dataImpacto = parseDataBR(colM);
    if (!dataImpacto) continue;

    const diasAtePagamento = diasUteisEntre(dataRef, dataImpacto);
    const diasFinal  = diasAtePagamento < 0 ? null : diasAtePagamento;
    const vertice    = diasParaVertice(diasFinal);
    const dataOperacao = parseDataBR(colK);
    const dataBoleta   = parseDataBR(colJ);

    const codigo_clt = resolveCodigoClt(cotista, deParaLookup);

    rows.push({
      fonte,
      fundo,
      fundo_cnpj: colH ? String(colH).replace(/\D/g, '').padStart(14, '0') || null : null,
      cotista,
      contato,
      codigo_clt,
      valor,
      data_impacto: toIsoDate(dataImpacto),
      data_operacao:  dataOperacao ? toIsoDate(dataOperacao)  : null,
      data_boleta:    dataBoleta   ? toIsoDate(dataBoleta)    : null,
      tipo_movimento: tipoMovimento || null,
      dias_ate_pagamento: diasFinal,
      vertice,
    });
  }

  return rows;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Content-Type deve ser multipart/form-data. Envie o arquivo no campo "file" e data_referencia (YYYYMMDD).',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const formData = await req.formData();
    const file             = formData.get('file');
    const dataRefParam     = formData.get('data_referencia') as string | null;
    const importModeParam  = String(formData.get('modo_importacao') || 'incremental').trim().toLowerCase();
    const importMode: ImportMode = importModeParam === 'substituir_periodo' ? 'substituir_periodo' : 'incremental';

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhum arquivo enviado. Use o campo "file".' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const today = new Date();
    const dataRefDefault = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const dataReferencia = dataRefParam && /^\d{8}$/.test(dataRefParam) ? dataRefParam : dataRefDefault;

    // Carrega De-Para antes de parsear o XLSX
    const deParaLookup = await buildDeParaLookup();
    console.log('[import-resgates] De-Para carregado, exactMap size:', deParaLookup.exactMap.size);

    const buffer = await file.arrayBuffer();
    const rows   = parseMovimentacoesXlsx(buffer, file.name, dataReferencia, deParaLookup);

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Nenhum registro de resgate encontrado. Verifique se o arquivo contém coluna "Data impacto" (M) e linhas com "RESGATE" em Tipo movimento.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const codigosVinculados = rows.filter((r) => r.codigo_clt != null).length;
    console.log(`[import-resgates] ${rows.length} resgates parseados, ${codigosVinculados} com codigo_clt resolvido`);

    const toInsert = rows.map((r) => ({
      fonte:              r.fonte,
      fundo:              r.fundo,
      fundo_cnpj:         r.fundo_cnpj,
      cotista:            r.cotista,
      contato:            r.contato,
      codigo_clt:         r.codigo_clt,
      valor:              r.valor,
      data_impacto:       r.data_impacto,
      data_operacao:      r.data_operacao,
      data_boleta:        r.data_boleta,
      tipo_movimento:     r.tipo_movimento || '',
      dias_ate_pagamento: r.dias_ate_pagamento,
      vertice:            r.vertice,
    }));

    let registrosRemovidos = 0;
    if (importMode === 'substituir_periodo') {
      const fundos  = [...new Set(rows.map((r) => r.fundo).filter(Boolean))];
      const datas   = rows.map((r) => r.data_impacto).filter(Boolean).sort();
      const dataMin = datas[0];
      const dataMax = datas[datas.length - 1];

      if (fundos.length > 0 && dataMin && dataMax) {
        const { count, error: deleteError } = await supabase
          .from('resgates_movimentacoes')
          .delete({ count: 'exact' })
          .in('fundo', fundos)
          .gte('data_impacto', dataMin)
          .lte('data_impacto', dataMax);

        if (deleteError) {
          console.error('[import-resgates] Erro ao remover período:', deleteError);
          return new Response(
            JSON.stringify({ success: false, error: `Erro ao remover período: ${deleteError.message}` }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
        registrosRemovidos = count ?? 0;
      }
    }

    const BATCH = 100;
    let total = 0;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH);
      const { error } = await supabase
        .from('resgates_movimentacoes')
        .upsert(batch, {
          onConflict: 'fundo,cotista,data_impacto,valor,tipo_movimento',
          ignoreDuplicates: true,
        });
      if (error) {
        console.error('[import-resgates] Erro ao inserir:', error);
        return new Response(
          JSON.stringify({ success: false, error: `Erro ao inserir: ${error.message}`, recordsInserted: total }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      total += batch.length;
    }

    return new Response(
      JSON.stringify({
        success: true,
        recordsInserted: total,
        codigosVinculados,
        mode: importMode,
        recordsRemoved: registrosRemovidos,
        message: importMode === 'substituir_periodo'
          ? `${total} resgates importados (${registrosRemovidos} removidos no período). ${codigosVinculados} cotistas vinculados via De-Para.`
          : `${total} resgates importados. ${codigosVinculados} cotistas vinculados via De-Para.`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[import-resgates] Erro:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Erro desconhecido' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
