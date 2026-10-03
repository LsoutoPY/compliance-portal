/**
 * Edge Function: import-caixa-fluxo-financeiro
 *
 * Importa movimentações de fluxo financeiro da planilha CaixaFluxoFinanceiro (XLSX).
 * Filtra linhas com subtipo "Resgate do/de portfólio investido" e armazena na tabela
 * caixa_fluxo_financeiro para monitoramento de descasamento operacional.
 *
 * O CNPJ do fundo analisador é lido diretamente da coluna "CNPJ da classe" de cada linha
 * da planilha — permitindo que um único arquivo contenha dados de múltiplos fundos.
 *
 * Request: multipart/form-data
 *   - file:       arquivo XLSX (CaixaFluxoFinanceiro)
 *   - fundo_cnpj: (opcional) filtro — se informado, importa apenas linhas desse fundo
 *   - fundo_nome: (ignorado, mantido por compatibilidade)
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

/**
 * Verifica se um subtipo corresponde a "Resgate de/do portfólio investido".
 * Usa correspondência parcial nos termos-chave para cobrir variações de preposição.
 */
function isResgatePortfolioInvestido(subtipoNorm: string): boolean {
  return (
    subtipoNorm.includes('resgate') &&
    subtipoNorm.includes('portfolio') &&
    subtipoNorm.includes('investido')
  );
}

/**
 * Normaliza CNPJ: remove pontuação, retorna string vazia se não restar dígitos.
 * Suporta "34.218.601/0001-97", "34218601000197", number, null etc.
 */
function normalizarCnpj(s: unknown): string {
  const digits = String(s ?? '').replace(/\D/g, '');
  return digits; // sem padStart — CNPJ vazio retorna ''
}

/**
 * Converte serial Excel para Date usando componentes UTC para evitar deslocamento de fuso.
 */
function excelSerialParaDate(serial: number): Date {
  const ms = (serial - 25569) * 86400 * 1000;
  const utc = new Date(ms);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

/**
 * Converte vários formatos de data para Date.
 * Suporta: serial numérico do Excel, DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD.
 */
function parseData(val: unknown): Date | null {
  if (val == null) return null;

  if (typeof val === 'number' && val > 1000) {
    return excelSerialParaDate(val);
  }

  const s = String(val).trim();

  const mBR = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mBR) {
    const dt = new Date(parseInt(mBR[3], 10), parseInt(mBR[2], 10) - 1, parseInt(mBR[1], 10));
    return isNaN(dt.getTime()) ? null : dt;
  }

  const mISO = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mISO) {
    const dt = new Date(parseInt(mISO[1], 10), parseInt(mISO[2], 10) - 1, parseInt(mISO[3], 10));
    return isNaN(dt.getTime()) ? null : dt;
  }

  const n = Number(s);
  if (!isNaN(n) && n > 1000) return excelSerialParaDate(n);

  return null;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseValor(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number' && !isNaN(v)) return v;
  const s = String(v).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Normaliza string para comparação: minúsculas, remove acentos, trim. */
function norm(s: unknown): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

interface FluxoRow {
  fundo_cnpj: string;
  fundo: string | null;
  subtipo: string;
  descricao: string | null;
  financeiro: number;
  data_liquidacao: string; // ISO YYYY-MM-DD
  arquivo_origem: string;
}

interface ParseResult {
  rows: FluxoRow[];
  totalLinhas: number;       // total de linhas de dados
  linhasResgate: number;     // linhas com subtipo "Resgate..."
  linhasSemCnpj: number;     // linhas válidas ignoradas por CNPJ não detectado
  linhasSemData: number;     // linhas válidas ignoradas por data inválida
  colunasDetectadas: Record<string, number>; // índices das colunas detectadas
}

/**
 * Parseia o XLSX e extrai linhas de "Resgate do/de portfólio investido".
 *
 * Detecta automaticamente as colunas pelo nome (case-insensitive, sem acento).
 * Lê o CNPJ do fundo analisador da coluna "CNPJ da classe" de cada linha.
 *
 * @param filtroFundoCnpj  Se informado, importa apenas linhas desse fundo (filtragem opcional).
 *                         Se omitido, importa todos os fundos encontrados no arquivo.
 */
function parseCaixaFluxoXlsx(
  buffer: ArrayBuffer,
  arquivoOrigem: string,
  filtroFundoCnpj?: string,
): ParseResult {
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], totalLinhas: 0, linhasResgate: 0, linhasSemCnpj: 0, linhasSemData: 0, colunasDetectadas: {} };

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  let headerRow = -1;
  let colSubtipo = -1;
  let colDataLiquidacao = -1;
  let colFinanceiro = -1;
  let colDescricao = -1;
  let colCnpjClasse = -1;
  let colNomeClasse = -1;

  for (let r = 0; r <= Math.min(range.e.r, 15); r++) {
    let foundSubtipo = -1;
    let foundData = -1;
    let foundFin = -1;
    let foundDesc = -1;
    let foundCnpj = -1;
    let foundNome = -1;

    for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      const v = norm(cell?.v);
      if (v.includes('subtipo')) foundSubtipo = c;
      if (v.includes('data') && v.includes('liquidac')) foundData = c;
      if (v.includes('financeiro')) foundFin = c;
      if (v.includes('descric') && !v.includes('cnpj')) foundDesc = c;
      // "CNPJ da classe" — detecta por cnpj + class
      if (v.includes('cnpj') && v.includes('class')) foundCnpj = c;
      // "Nome da classe/subclasse" — detecta por nome + class (sem confundir com cnpj)
      if (v.includes('nome') && v.includes('class') && !v.includes('cnpj')) foundNome = c;
    }

    if (foundSubtipo !== -1 && foundData !== -1) {
      headerRow = r;
      colSubtipo = foundSubtipo;
      colDataLiquidacao = foundData;
      colFinanceiro = foundFin;
      colDescricao = foundDesc;
      colCnpjClasse = foundCnpj;
      colNomeClasse = foundNome;
      break;
    }
  }

  if (headerRow === -1) {
    console.warn('[import-caixa-fluxo] Cabeçalho não encontrado na planilha.');
    return { rows: [], totalLinhas: 0, linhasResgate: 0, linhasSemCnpj: 0, linhasSemData: 0, colunasDetectadas: {} };
  }

  const colunasDetectadas = {
    subtipo: colSubtipo,
    data_liquidacao: colDataLiquidacao,
    financeiro: colFinanceiro,
    descricao: colDescricao,
    cnpj_classe: colCnpjClasse,
    nome_classe: colNomeClasse,
  };

  console.log(
    `[import-caixa-fluxo] Cabeçalho na linha ${headerRow} | ` +
    Object.entries(colunasDetectadas).map(([k, v]) => `${k}=col${v}`).join(' | ')
  );

  if (colCnpjClasse === -1) {
    console.warn(
      '[import-caixa-fluxo] Coluna "CNPJ da classe" não encontrada na planilha. ' +
      'Linhas de resgate serão importadas com fundo_cnpj do filtro (se fornecido) ou vazio.'
    );
  }

  const rows: FluxoRow[] = [];
  let totalLinhas = 0;
  let linhasResgate = 0;
  let linhasSemCnpj = 0;
  let linhasSemData = 0;

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const subtipoCell = ws[XLSX.utils.encode_cell({ r, c: colSubtipo })];
    const subtipoValor = String(subtipoCell?.v ?? '').trim();

    // Linha vazia (sem subtipo): ignora silenciosamente
    if (!subtipoValor) continue;
    totalLinhas++;

    if (!isResgatePortfolioInvestido(norm(subtipoValor))) continue;
    linhasResgate++;

    // Resolve CNPJ do fundo analisador: prioridade → coluna da planilha → filtro do form
    let fundoCnpjLinha = '';
    if (colCnpjClasse !== -1) {
      const cnpjCell = ws[XLSX.utils.encode_cell({ r, c: colCnpjClasse })];
      fundoCnpjLinha = normalizarCnpj(cnpjCell?.v);
    }
    if (!fundoCnpjLinha && filtroFundoCnpj) {
      fundoCnpjLinha = filtroFundoCnpj;
    }

    if (!fundoCnpjLinha) {
      // CNPJ não detectável: importa com aviso mas NÃO pula a linha
      linhasSemCnpj++;
      console.warn(`[import-caixa-fluxo] Linha ${r + 1}: CNPJ não detectado — importando com fundo_cnpj vazio.`);
    }

    // Aplica filtro opcional: pula linhas de outros fundos
    if (filtroFundoCnpj && fundoCnpjLinha && fundoCnpjLinha !== filtroFundoCnpj) continue;

    const dataCell = ws[XLSX.utils.encode_cell({ r, c: colDataLiquidacao })];
    const dataLiquidacao = parseData(dataCell?.v);
    if (!dataLiquidacao || isNaN(dataLiquidacao.getTime())) {
      linhasSemData++;
      console.warn(`[import-caixa-fluxo] Linha ${r + 1}: data de liquidação inválida (${dataCell?.v}), ignorada.`);
      continue;
    }

    const financeiro = colFinanceiro !== -1
      ? parseValor(ws[XLSX.utils.encode_cell({ r, c: colFinanceiro })]?.v)
      : 0;

    const descricaoCell = colDescricao !== -1 ? ws[XLSX.utils.encode_cell({ r, c: colDescricao })] : null;
    const descricao = descricaoCell?.v != null ? String(descricaoCell.v).trim() : null;

    let fundoNomeLinha: string | null = null;
    if (colNomeClasse !== -1) {
      const nomeCell = ws[XLSX.utils.encode_cell({ r, c: colNomeClasse })];
      fundoNomeLinha = nomeCell?.v != null ? String(nomeCell.v).trim() : null;
    }

    rows.push({
      fundo_cnpj: fundoCnpjLinha || '',
      fundo: fundoNomeLinha,
      subtipo: subtipoValor,
      descricao,
      financeiro,
      data_liquidacao: toIsoDate(dataLiquidacao),
      arquivo_origem: arquivoOrigem,
    });
  }

  console.log(
    `[import-caixa-fluxo] Resumo parse: total=${totalLinhas} | resgate=${linhasResgate} | ` +
    `semCnpj=${linhasSemCnpj} | semData=${linhasSemData} | importar=${rows.length}`
  );

  return { rows, totalLinhas, linhasResgate, linhasSemCnpj, linhasSemData, colunasDetectadas };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Content-Type deve ser multipart/form-data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    // fundo_cnpj agora é opcional — usado apenas como filtro se a planilha tiver múltiplos fundos
    const fundoCnpjFiltro = normalizarCnpj(String(formData.get('fundo_cnpj') ?? '').trim()) || undefined;

    if (!file) {
      return new Response(
        JSON.stringify({ success: false, error: 'Campo "file" obrigatório' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const arquivoOrigem = file.name;
    const buffer = await file.arrayBuffer();

    const parseResult = parseCaixaFluxoXlsx(buffer, arquivoOrigem, fundoCnpjFiltro);
    const { rows: linhas, totalLinhas, linhasResgate, linhasSemCnpj, linhasSemData, colunasDetectadas } = parseResult;

    console.log(
      `[import-caixa-fluxo] Parse concluído: total_linhas=${totalLinhas} | resgates=${linhasResgate} | ` +
      `sem_cnpj=${linhasSemCnpj} | sem_data=${linhasSemData} | a_inserir=${linhas.length} | ` +
      `filtro=${fundoCnpjFiltro ?? 'nenhum'}`
    );

    if (linhasResgate === 0) {
      const aviso = totalLinhas === 0
        ? 'Nenhuma linha de dados encontrada. Verifique se o arquivo é a planilha CaixaFluxoFinanceiro correta.'
        : `${totalLinhas} linhas lidas, mas nenhuma com subtipo "Resgate do/de portfólio investido". ` +
          `Subtipos presentes neste arquivo não correspondem ao filtro esperado.`;
      return new Response(
        JSON.stringify({
          success: true,
          inserted: 0,
          linhasResgate: 0,
          totalLinhas,
          colunasDetectadas,
          porFundo: [],
          message: aviso,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (linhas.length === 0) {
      // Havia resgates mas foram todos filtrados (ex: filtro de CNPJ excluiu tudo)
      return new Response(
        JSON.stringify({
          success: true,
          inserted: 0,
          linhasResgate,
          totalLinhas,
          colunasDetectadas,
          porFundo: [],
          message: `${linhasResgate} resgate(s) encontrado(s) mas nenhum passou no filtro de CNPJ (${fundoCnpjFiltro}).`,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Deleta registros existentes apenas para o intervalo de datas coberto por cada fundo
    // no arquivo atual. Isso preserva registros de outros períodos (rastreabilidade histórica)
    // e evita duplicatas causadas por reimports com nomes de arquivo diferentes.
    const rangePorCnpj = new Map<string, { min: string; max: string }>();
    for (const l of linhas) {
      if (!l.fundo_cnpj) continue;
      const existing = rangePorCnpj.get(l.fundo_cnpj);
      if (!existing) {
        rangePorCnpj.set(l.fundo_cnpj, { min: l.data_liquidacao, max: l.data_liquidacao });
      } else {
        if (l.data_liquidacao < existing.min) existing.min = l.data_liquidacao;
        if (l.data_liquidacao > existing.max) existing.max = l.data_liquidacao;
      }
    }

    for (const [cnpj, { min, max }] of rangePorCnpj) {
      const { error: deleteError } = await supabase
        .from('caixa_fluxo_financeiro')
        .delete()
        .eq('fundo_cnpj', cnpj)
        .gte('data_liquidacao', min)
        .lte('data_liquidacao', max);

      if (deleteError) {
        console.error(`[import-caixa-fluxo] Erro ao deletar registros de ${cnpj} (${min}→${max}):`, deleteError.message);
        throw deleteError;
      }
      console.log(`[import-caixa-fluxo] Deletados registros de ${cnpj} no intervalo ${min} → ${max}`);
    }

    const { error: insertError, count } = await supabase
      .from('caixa_fluxo_financeiro')
      .insert(linhas, { count: 'exact' });

    if (insertError) {
      console.error('[import-caixa-fluxo] Erro ao inserir linhas:', insertError.message);
      throw insertError;
    }

    const inserted = count ?? linhas.length;

    // Resumo agrupado por fundo
    const porFundoMap = new Map<string, { cnpj: string; nome: string | null; count: number }>();
    for (const l of linhas) {
      const key = l.fundo_cnpj || 'SEM_CNPJ';
      const entry = porFundoMap.get(key) ?? { cnpj: l.fundo_cnpj, nome: l.fundo, count: 0 };
      entry.count++;
      porFundoMap.set(key, entry);
    }
    const porFundo = [...porFundoMap.values()].sort((a, b) => b.count - a.count);

    console.log(
      `[import-caixa-fluxo] ${inserted} registro(s) inserido(s) em ${porFundo.length} fundo(s): ` +
      porFundo.map(f => `${f.nome ?? f.cnpj} (${f.count})`).join(', ')
    );

    const aviso = linhasSemCnpj > 0 ? ` (${linhasSemCnpj} sem CNPJ detectado)` : '';
    return new Response(
      JSON.stringify({
        success: true,
        inserted,
        linhasResgate,
        totalLinhas,
        colunasDetectadas,
        porFundo,
        message: `${inserted} registro(s) importado(s) para ${porFundo.length} fundo(s).${aviso}`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[import-caixa-fluxo] Erro inesperado:', err);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
