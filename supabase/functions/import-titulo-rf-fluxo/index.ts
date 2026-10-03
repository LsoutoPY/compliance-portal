/**
 * Edge Function: import-titulo-rf-fluxo
 *
 * Importa cronograma de amortizações / juros de títulos RF a partir de um arquivo
 * CSV ou XLSX, populando a tabela titulo_rf_fluxo e ativando
 * ativos.usa_fluxo_intermediario = true quando o ativo é encontrado no Cardápio.
 *
 * Formato esperado do arquivo (colunas obrigatórias):
 *   chave_ativo   — ex: "isin:BRKMLTNC008" ou "cetip:BRKMLTNCM008"
 *                   Aceita também só o código (ex: "BRKMLTNCM008"), nesse caso
 *                   o campo tipo_chave (ou a coluna "tipo_chave") define o prefixo.
 *   data_pagamento — ISO "YYYY-MM-DD" ou serial Excel
 *   valor_nominal  — número positivo (R$)
 *
 * Colunas opcionais:
 *   tipo_fluxo   — "amortizacao" | "juros" | "residual" (default "amortizacao")
 *   tipo_chave   — "isin" | "cetip"  (default "cetip", usado quando chave_ativo não tem prefixo)
 *   ordem        — inteiro (para ordenação de exibição)
 *
 * Request: multipart/form-data
 *   - file:       arquivo CSV (UTF-8 / ISO-8859-1, separador ";") ou XLSX
 *   - tipo_chave: (opcional) "isin" | "cetip" — prefixo padrão quando a coluna chave_ativo
 *                  não contém o prefixo "isin:" / "cetip:"
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

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normStr(s: unknown): string {
  return String(s ?? '').trim().toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[\s_-]+/g, '');
}

function parseTipoFluxo(raw: unknown): 'amortizacao' | 'juros' | 'residual' {
  const v = normStr(raw);
  if (v.includes('juro') || v.includes('cupon') || v.includes('juros')) return 'juros';
  if (v.includes('residual') || v.includes('bullet') || v.includes('principal')) return 'residual';
  return 'amortizacao';
}

function excelSerialParaIso(serial: number): string | null {
  if (!serial || serial < 1) return null;
  const ms = (serial - 25569) * 86400 * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Converte qualquer representação de data para ISO "YYYY-MM-DD" ou null. */
function parseDataCell(raw: unknown): string | null {
  if (raw == null) return null;
  // Serial Excel numérico
  if (typeof raw === 'number') return excelSerialParaIso(raw);
  const s = String(raw).trim();
  // Já ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${y}-${m}-${d}`;
  }
  // YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return null;
}

/** Normaliza a chave_ativo: garante prefixo "isin:" ou "cetip:". */
function normalizarChave(raw: unknown, tipoPadrao: 'isin' | 'cetip'): string | null {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith('ISIN:')) return s;
  if (s.startsWith('CETIP:')) return s;
  // Heurística: começa com "BR" e tem 12 chars → provavelmente ISIN
  if (/^BR[A-Z0-9]{10}$/.test(s)) return `isin:${s}`;
  return `${tipoPadrao}:${s}`;
}

/** Mapeia cabeçalhos de planilha para nomes canônicos. */
function resolverMapeamentoColunas(headers: string[]): Record<string, string> {
  const MAPA: Record<string, string> = {
    chave_ativo: 'chave_ativo',
    chave: 'chave_ativo',
    ativo: 'chave_ativo',
    isin: 'chave_ativo',
    codigo: 'chave_ativo',
    codativo: 'chave_ativo',
    data_pagamento: 'data_pagamento',
    data: 'data_pagamento',
    dt_pagamento: 'data_pagamento',
    vencimento: 'data_pagamento',
    dt_vencimento: 'data_pagamento',
    valor_nominal: 'valor_nominal',
    valor: 'valor_nominal',
    vn: 'valor_nominal',
    nominal: 'valor_nominal',
    tipo_fluxo: 'tipo_fluxo',
    tipo: 'tipo_fluxo',
    fluxo: 'tipo_fluxo',
    tipo_chave: 'tipo_chave',
    ordem: 'ordem',
  };
  const mapeamento: Record<string, string> = {};
  for (const h of headers) {
    const k = normStr(h);
    if (MAPA[k]) mapeamento[h] = MAPA[k];
  }
  return mapeamento;
}

// ──────────────────────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────────────────────

interface LinhaFluxo {
  chave_ativo: string;
  data_pagamento: string;
  valor_nominal: number;
  tipo_fluxo: 'amortizacao' | 'juros' | 'residual';
  tipo_chave: 'isin' | 'cetip';
  ordem: number | null;
}

function parsePlanilha(
  buffer: ArrayBuffer,
  nomeArquivo: string,
  tipoPadrao: 'isin' | 'cetip',
): { linhas: LinhaFluxo[]; erros: string[] } {
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, {
    raw: true,
    defval: null,
  });

  if (rows.length === 0) {
    return { linhas: [], erros: ['Planilha vazia ou sem dados após o cabeçalho'] };
  }

  const headers = Object.keys(rows[0]);
  const colMap = resolverMapeamentoColunas(headers);

  const linhas: LinhaFluxo[] = [];
  const erros: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nLinha = i + 2; // +2 = header + 1-indexed

    const get = (campo: string) => {
      const col = Object.keys(colMap).find((h) => colMap[h] === campo);
      return col ? row[col] : null;
    };

    const rawChave = get('chave_ativo');
    const rawData = get('data_pagamento');
    const rawValor = get('valor_nominal');

    if (rawChave == null && rawData == null && rawValor == null) continue; // linha em branco

    // Tipo de chave da linha (coluna opcional) ou o padrão do request
    const tipoColunaRaw = get('tipo_chave');
    const tipoChave: 'isin' | 'cetip' =
      tipoColunaRaw && normStr(tipoColunaRaw).includes('isin') ? 'isin' : tipoPadrao;

    const chave = normalizarChave(rawChave, tipoChave);
    if (!chave) {
      erros.push(`Linha ${nLinha}: chave_ativo ausente ou inválida ("${rawChave}")`);
      continue;
    }

    const data = parseDataCell(rawData);
    if (!data) {
      erros.push(`Linha ${nLinha}: data_pagamento inválida ("${rawData}")`);
      continue;
    }

    const valor = Number(String(rawValor ?? '').replace(',', '.'));
    if (!Number.isFinite(valor) || valor <= 0) {
      erros.push(`Linha ${nLinha}: valor_nominal inválido ("${rawValor}")`);
      continue;
    }

    linhas.push({
      chave_ativo: chave,
      data_pagamento: data,
      valor_nominal: valor,
      tipo_fluxo: parseTipoFluxo(get('tipo_fluxo')),
      tipo_chave: tipoChave,
      ordem: get('ordem') != null ? Number(get('ordem')) : null,
    });
  }

  return { linhas, erros };
}

// ──────────────────────────────────────────────────────────────
// Persistência
// ──────────────────────────────────────────────────────────────

interface Resumo {
  total_linhas_planilha: number;
  linhas_importadas: number;
  erros_parse: string[];
  chaves_distintas: string[];
  ativos_marcados_fluxo: number;
}

async function persistirFluxos(
  linhas: LinhaFluxo[],
  arquivoOrigem: string,
): Promise<Resumo> {
  if (linhas.length === 0) {
    return {
      total_linhas_planilha: 0,
      linhas_importadas: 0,
      erros_parse: [],
      chaves_distintas: [],
      ativos_marcados_fluxo: 0,
    };
  }

  // Registros para upsert
  const records = linhas.map((l, idx) => ({
    chave_ativo: l.chave_ativo,
    data_pagamento: l.data_pagamento,
    valor_nominal: l.valor_nominal,
    tipo_fluxo: l.tipo_fluxo,
    ordem: l.ordem ?? idx + 1,
    arquivo_origem: arquivoOrigem,
  }));

  // Upsert em lotes de 500
  const BATCH = 500;
  let importados = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error } = await supabase
      .from('titulo_rf_fluxo' as never)
      .upsert(batch, { onConflict: 'chave_ativo,data_pagamento,tipo_fluxo,valor_nominal' });
    if (error) throw new Error(`Erro ao inserir lote ${i}: ${error.message}`);
    importados += batch.length;
  }

  // Chaves distintas importadas
  const chavesSet = new Set(linhas.map((l) => l.chave_ativo));
  const chaves = Array.from(chavesSet);

  // Tentar vincular ativo_id e marcar usa_fluxo_intermediario = true
  let ativosMarkados = 0;
  for (const chave of chaves) {
    const prefixo = chave.startsWith('isin:') ? 'isin' : 'cetip';
    const codigo = chave.split(':').slice(1).join(':');

    let ativoId: string | null = null;

    if (prefixo === 'isin') {
      const { data } = await supabase
        .from('ativos' as never)
        .select('id')
        .eq('isin', codigo)
        .limit(1)
        .maybeSingle();
      ativoId = (data as { id: string } | null)?.id ?? null;
    } else {
      const { data } = await supabase
        .from('ativos' as never)
        .select('id')
        .eq('codigo_cetip_selic', codigo)
        .limit(1)
        .maybeSingle();
      ativoId = (data as { id: string } | null)?.id ?? null;
    }

    if (ativoId) {
      // Atualizar as linhas para vincular ativo_id
      await supabase
        .from('titulo_rf_fluxo' as never)
        .update({ ativo_id: ativoId })
        .eq('chave_ativo', chave)
        .is('ativo_id', null);

      // Marcar o ativo como usa_fluxo_intermediario
      const { error: updErr } = await supabase
        .from('ativos' as never)
        .update({ usa_fluxo_intermediario: true, metodo_prazo_rf: 'fluxo_nominal' })
        .eq('id', ativoId);

      if (!updErr) ativosMarkados++;
    }
  }

  return {
    total_linhas_planilha: linhas.length,
    linhas_importadas: importados,
    erros_parse: [],
    chaves_distintas: chaves,
    ativos_marcados_fluxo: ativosMarkados,
  };
}

// ──────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Envie o arquivo via multipart/form-data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) {
      return new Response(
        JSON.stringify({ success: false, error: 'Campo "file" não encontrado no formulário' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const tipoPadrao = String(form.get('tipo_chave') ?? 'cetip').trim().toLowerCase() as 'isin' | 'cetip';

    const buffer = await file.arrayBuffer();
    const { linhas, erros: errosParse } = parsePlanilha(buffer, file.name, tipoPadrao);

    if (linhas.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Nenhuma linha válida encontrada na planilha',
          erros_parse: errosParse,
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const resumo = await persistirFluxos(linhas, file.name);
    resumo.erros_parse = errosParse;

    console.log(
      `[import-titulo-rf-fluxo] ${file.name}: ${resumo.linhas_importadas} fluxos | ` +
      `${resumo.chaves_distintas.length} chaves | ` +
      `${resumo.ativos_marcados_fluxo} ativos marcados`,
    );

    return new Response(
      JSON.stringify({ success: true, ...resumo }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[import-titulo-rf-fluxo] Erro inesperado:', err);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
