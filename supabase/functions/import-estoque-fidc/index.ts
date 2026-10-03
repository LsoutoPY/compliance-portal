/**
 * Edge Function: import-estoque-fidc
 *
 * Importa planilhas CSV de Estoque FIDC extraídas do Frontis.
 * Foco: importação, padronização, armazenamento, log e rastreabilidade.
 * Sem regras de negócio de crédito, PDD ou roll rate nesta etapa.
 *
 * Request: multipart/form-data
 *   - file: arquivo CSV (delimitador ";", encoding UTF-8 ou Windows-1252/ISO-8859-1)
 *
 * Fluxo:
 *   1. Valida arquivo (presença, extensão, encoding)
 *   2. Parseia CSV com delimitador ";"
 *   3. Valida cabeçalho mínimo
 *   4. Cria registro em importacoes_estoque_fidc (status: processing)
 *   5. Salva linhas brutas em estoque_fidc_raw (staging/rastreabilidade)
 *   6. Transforma e insere em estoque_fidc (normalizado)
 *   7. Atualiza status da importação
 *   8. Retorna resposta detalhada
 *
 * Regra de duplicidade (conservadora):
 *   - Chave preferencial: seu_numero
 *   - Chave alternativa: nu_documento + doc_sacado + data_vencimento_ajustada
 *   - Sem chave: importado com log de aviso (não rejeitado)
 *   - Importações duplicadas por fundo+data_referencia: alertadas, não bloqueadas
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

// Colunas obrigatórias no cabeçalho para que a importação prossiga
const REQUIRED_COLUMNS = ['NOME_FUNDO', 'DOC_FUNDO', 'DATA_REFERENCIA'];

// Pelo menos uma dessas colunas deve estar presente
const KEY_COLUMNS = ['SEU_NUMERO', 'NU_DOCUMENTO'];

// Tamanho dos lotes de inserção no banco
const BATCH_SIZE = 200;

// =====================================================================
// Decodificação de conteúdo com fallback de encoding
// Tenta UTF-8 strict primeiro; se falhar, tenta Windows-1252 (cp1252)
// e ISO-8859-1 como último recurso.
// =====================================================================
function decodeContent(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return new TextDecoder('iso-8859-1').decode(bytes);
    }
  }
}

// =====================================================================
// Converte número no padrão brasileiro para float
// "1.736,93" → 1736.93 | "0,10000000" → 0.1 | "" → null
// =====================================================================
function parseBrDecimal(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === '' || s === '-') return null;
  // Remove separadores de milhar (.) e substitui vírgula decimal por ponto
  const normalized = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(normalized);
  return isNaN(n) ? null : n;
}

// =====================================================================
// Converte data no padrão dd/mm/yyyy para string ISO yyyy-mm-dd
// =====================================================================
function parseBrDate(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === '') return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// =====================================================================
// Converte string para inteiro ou null
// =====================================================================
function parseIntOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === '') return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// =====================================================================
// Normaliza texto: trim, string vazia → null
// =====================================================================
function textOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  return s === '' ? null : s;
}

// =====================================================================
// Parser CSV robusto: suporta delimitador ";", campos quoted e BOM
// =====================================================================
function parseCSV(content: string): string[][] {
  // Remove BOM se presente
  const cleaned = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const lines = cleaned.split(/\r?\n/);
  const result: string[][] = [];

  for (const line of lines) {
    if (line.trim() === '') continue;
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ';' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    result.push(fields);
  }

  return result;
}

// =====================================================================
// Transforma linha raw (Record<coluna, valor>) no formato da tabela
// estoque_fidc. Não inventa valores: campos ausentes → null.
// =====================================================================
function transformRow(raw: Record<string, string>, importId: string): Record<string, unknown> {
  return {
    import_id:                importId,
    source_system:            'frontis',
    nome_fundo:               textOrNull(raw['NOME_FUNDO']),
    doc_fundo:                textOrNull(raw['DOC_FUNDO']),
    nome_originador:          textOrNull(raw['NOME_ORIGINADOR']),
    doc_originador:           textOrNull(raw['DOC_ORIGINADOR']),
    nome_cedente:             textOrNull(raw['NOME_CEDENTE']),
    doc_cedente:              textOrNull(raw['DOC_CEDENTE']),
    nome_sacado:              textOrNull(raw['NOME_SACADO']),
    doc_sacado:               textOrNull(raw['DOC_SACADO']),
    tipo_recebivel:           textOrNull(raw['TIPO_RECEBIVEL']),
    valor_nominal:            parseBrDecimal(raw['VALOR_NOMINAL']),
    valor_presente:           parseBrDecimal(raw['VALOR_PRESENTE']),
    valor_aquisicao:          parseBrDecimal(raw['VALOR_AQUISICAO']),
    valor_pdd:                parseBrDecimal(raw['VALOR_PDD']),
    data_vencimento_ajustada: parseBrDate(raw['DATA_VENCIMENTO_AJUSTADA']),
    data_emissao:             parseBrDate(raw['DATA_EMISSAO']),
    data_aquisicao:           parseBrDate(raw['DATA_AQUISICAO']),
    nu_documento:             textOrNull(raw['NU_DOCUMENTO']),
    seu_numero:               textOrNull(raw['SEU_NUMERO']),
    tx_recebivel:             parseBrDecimal(raw['TX_RECEBIVEL']),
    prazo:                    parseIntOrNull(raw['PRAZO']),
    prazo_atual:              parseIntOrNull(raw['PRAZO_ATUAL']),
    situacao_recebivel:       textOrNull(raw['SITUACAO_RECEBIVEL']),
    faixa_pdd:                textOrNull(raw['FAIXA_PDD']),
    data_vencimento_original: parseBrDate(raw['DATA_VENCIMENTO_ORIGINAL']),
    taxa_cessao:              parseBrDecimal(raw['TAXA_CESSAO']),
    coobrigacao:              textOrNull(raw['COOBRIGACAO']),
    data_fundo:               parseBrDate(raw['DATA_FUNDO']),
    data_referencia:          parseBrDate(raw['DATA_REFERENCIA']),
    mora:                     parseBrDecimal(raw['MORA']),
    multa:                    parseBrDecimal(raw['MULTA']),
    taxa_juros_vencidos:      parseBrDecimal(raw['TAXA_JUROS_VENCIDOS']),
    data_carencia:            parseBrDate(raw['DATA_CARENCIA']),
    taxa_juros_indexador:     parseBrDecimal(raw['TAXA_JUROS_INDEXADOR']),
    tp_juros:                 textOrNull(raw['TP_JUROS']),
    defasagem:                textOrNull(raw['DEFASAGEM']),
    nome:                     textOrNull(raw['NOME']),
    valor_nominal_iof:        parseBrDecimal(raw['VALOR_NOMINAL_IOF']),
    nu_banco_cheque:          textOrNull(raw['NU_BANCO_CHEQUE']),
    nu_agencia_cheque:        textOrNull(raw['NU_AGENCIA_CHEQUE']),
    nu_conta_cheque:          textOrNull(raw['NU_CONTA_CHEQUE']),
    cmc7_cheque:              textOrNull(raw['CMC7_CHEQUE']),
    codigo_origem:            textOrNull(raw['CODIGO_ORIGEM']),
    codigo_finalidade:        textOrNull(raw['CODIGO_FINALIDADE']),
    id_registro:              textOrNull(raw['ID_REGISTRO']),
    faixa_pdd_geral:          textOrNull(raw['FAIXA_PDD_GERAL']),
    tipo_pdd_geral:           textOrNull(raw['TIPO_PDD_GERAL']),
    valor_pdd_geral:          parseBrDecimal(raw['VALOR_PDD_GERAL']),
    chave_nfe:                textOrNull(raw['CHAVE_NFE']),
  };
}

// =====================================================================
// Handler principal
// =====================================================================
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ── 1. Validar Content-Type ──────────────────────────────────────
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Content-Type deve ser multipart/form-data. Envie o CSV no campo "file".',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 2. Ler arquivo ───────────────────────────────────────────────
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhum arquivo enviado. Use o campo "file".' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!file.name.toLowerCase().endsWith('.csv')) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Extensão inválida: "${file.name}". Envie um arquivo CSV do Frontis.`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 3. Decodificar conteúdo com fallback de encoding ─────────────
    const bytes = new Uint8Array(await file.arrayBuffer());
    let content: string;
    try {
      content = decodeContent(bytes);
    } catch (encErr) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Falha ao decodificar o arquivo: ${encErr instanceof Error ? encErr.message : String(encErr)}`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (content.trim() === '') {
      return new Response(
        JSON.stringify({ success: false, error: 'Arquivo CSV vazio.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 4. Parsear CSV ───────────────────────────────────────────────
    let parsedRows: string[][];
    try {
      parsedRows = parseCSV(content);
    } catch (parseErr) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Falha ao parsear o CSV: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (parsedRows.length < 2) {
      return new Response(
        JSON.stringify({ success: false, error: 'CSV sem linhas de dados (apenas cabeçalho ou vazio).' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Normaliza cabeçalhos: trim + uppercase
    const headers = parsedRows[0].map(h => h.trim().toUpperCase());
    const dataRows = parsedRows.slice(1);

    // ── 5. Validar cabeçalho mínimo ──────────────────────────────────
    const missingRequired = REQUIRED_COLUMNS.filter(col => !headers.includes(col));
    if (missingRequired.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Colunas obrigatórias ausentes no cabeçalho: ${missingRequired.join(', ')}`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const hasKeyColumn = KEY_COLUMNS.some(col => headers.includes(col));
    if (!hasKeyColumn) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Pelo menos uma coluna de identificação deve estar presente: ${KEY_COLUMNS.join(' ou ')}`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── 6. Extrair dados do fundo a partir da primeira linha ─────────
    const firstRowObj: Record<string, string> = {};
    headers.forEach((h, i) => { firstRowObj[h] = dataRows[0]?.[i] ?? ''; });

    const fundDocument  = textOrNull(firstRowObj['DOC_FUNDO']);
    const fundName      = textOrNull(firstRowObj['NOME_FUNDO']);
    const referenceDate = parseBrDate(firstRowObj['DATA_REFERENCIA']);

    // ── 7. Verificar possível duplicidade (alertar, não bloquear) ────
    let duplicateWarning: string | null = null;
    if (fundDocument && referenceDate) {
      const { data: existingImports } = await supabase
        .from('importacoes_estoque_fidc')
        .select('id, created_at')
        .eq('fund_document', fundDocument)
        .eq('reference_date', referenceDate)
        .in('status', ['success', 'partial_success'])
        .limit(1);

      if (existingImports && existingImports.length > 0) {
        duplicateWarning = `Atenção: já existe uma importação de sucesso para o fundo ${fundDocument} na data de referência ${referenceDate}. Esta importação prosseguirá, mas verifique se é intencional.`;
        console.warn(`[import-estoque-fidc] ${duplicateWarning}`);
      }
    }

    // ── 8. Criar registro de controle (status: processing) ──────────
    const { data: importRecord, error: importError } = await supabase
      .from('importacoes_estoque_fidc')
      .insert({
        file_name:      file.name,
        file_type:      'csv',
        source_system:  'frontis',
        status:         'processing',
        reference_date: referenceDate,
        fund_document:  fundDocument,
        fund_name:      fundName,
        total_rows:     dataRows.length,
      })
      .select('id')
      .single();

    if (importError || !importRecord) {
      console.error('[import-estoque-fidc] Erro ao criar registro de importação:', importError);
      return new Response(
        JSON.stringify({
          success: false,
          error: `Erro ao criar registro de importação: ${importError?.message ?? 'resposta vazia'}`,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const importId = importRecord.id;
    const errors: string[] = [];
    if (duplicateWarning) errors.push(duplicateWarning);

    // ── 9. Salvar staging raw (para rastreabilidade) ─────────────────
    const rawToInsert = dataRows.map((row, idx) => {
      const rowObj: Record<string, string> = {};
      headers.forEach((h, i) => { rowObj[h] = row[i] ?? ''; });
      return { import_id: importId, row_number: idx + 1, raw_payload: rowObj };
    });

    for (let i = 0; i < rawToInsert.length; i += BATCH_SIZE) {
      const batch = rawToInsert.slice(i, i + BATCH_SIZE);
      const { error: rawErr } = await supabase.from('estoque_fidc_raw').insert(batch);
      if (rawErr) {
        // Falha no raw é não-fatal: loga e continua
        const warn = `Aviso: erro ao salvar staging raw (lote ${Math.floor(i / BATCH_SIZE) + 1}): ${rawErr.message}`;
        console.warn(`[import-estoque-fidc] ${warn}`);
        errors.push(warn);
      }
    }

    // ── 10. Transformar e inserir dados normalizados ─────────────────
    let importedRows = 0;
    let rejectedRows = 0;
    const normalizedToInsert: Record<string, unknown>[] = [];

    for (let idx = 0; idx < dataRows.length; idx++) {
      const row     = dataRows[idx];
      const rowNum  = idx + 1;
      const rawObj: Record<string, string> = {};
      headers.forEach((h, i) => { rawObj[h] = row[i] ?? ''; });

      // Validação por linha: campos obrigatórios
      const nomeFundo = textOrNull(rawObj['NOME_FUNDO']);
      const docFundo  = textOrNull(rawObj['DOC_FUNDO']);
      const dataRef   = parseBrDate(rawObj['DATA_REFERENCIA']);

      if (!nomeFundo || !docFundo || !dataRef) {
        rejectedRows++;
        errors.push(
          `Linha ${rowNum}: rejeitada — campos obrigatórios ausentes ` +
          `(NOME_FUNDO="${rawObj['NOME_FUNDO'] ?? ''}", ` +
          `DOC_FUNDO="${rawObj['DOC_FUNDO'] ?? ''}", ` +
          `DATA_REFERENCIA="${rawObj['DATA_REFERENCIA'] ?? ''}")`
        );
        continue;
      }

      // Avaliação da robustez da chave (log apenas, não rejeita)
      const seuNumero      = textOrNull(rawObj['SEU_NUMERO']);
      const nuDocumento    = textOrNull(rawObj['NU_DOCUMENTO']);
      const docSacado      = textOrNull(rawObj['DOC_SACADO']);
      const dataVencAj     = parseBrDate(rawObj['DATA_VENCIMENTO_AJUSTADA']);

      if (!seuNumero && !nuDocumento) {
        errors.push(
          `Linha ${rowNum}: sem chave robusta — SEU_NUMERO e NU_DOCUMENTO ambos vazios. Importado sem chave lógica.`
        );
      } else if (!seuNumero && (!docSacado || !dataVencAj)) {
        errors.push(
          `Linha ${rowNum}: chave alternativa incompleta — SEU_NUMERO vazio e faltam ` +
          `DOC_SACADO ou DATA_VENCIMENTO_AJUSTADA. Importado com chave parcial.`
        );
      }

      normalizedToInsert.push(transformRow(rawObj, importId));
    }

    // Inserção em lotes
    for (let i = 0; i < normalizedToInsert.length; i += BATCH_SIZE) {
      const batch = normalizedToInsert.slice(i, i + BATCH_SIZE);
      const { error: normErr } = await supabase.from('estoque_fidc').insert(batch);
      if (normErr) {
        console.error(`[import-estoque-fidc] Erro ao inserir lote normalizado ${i}: ${normErr.message}`);
        rejectedRows += batch.length;
        errors.push(
          `Erro ao inserir linhas ${i + 1}–${i + batch.length}: ${normErr.message}`
        );
      } else {
        importedRows += batch.length;
      }
    }

    // ── 11. Determinar e registrar status final ──────────────────────
    // Erros estruturais (não contam avisos/alertas de chave)
    const hardErrors = errors.filter(
      e => !e.startsWith('Atenção:') && !e.startsWith('Aviso:') &&
           !e.startsWith('Linha') && e.includes('Erro ao inserir')
    );
    const finalStatus: string =
      rejectedRows === 0 && hardErrors.length === 0
        ? 'success'
        : importedRows > 0
          ? 'partial_success'
          : 'error';

    await supabase
      .from('importacoes_estoque_fidc')
      .update({
        status:        finalStatus,
        imported_rows: importedRows,
        rejected_rows: rejectedRows,
        // Persiste até 20 erros no registro de importação
        error_message: errors.length > 0 ? errors.slice(0, 20).join('\n') : null,
      })
      .eq('id', importId);

    console.log(
      `[import-estoque-fidc] Concluído: importId=${importId} ` +
      `status=${finalStatus} importadas=${importedRows} rejeitadas=${rejectedRows}`
    );

    // ── 12. Resposta detalhada ───────────────────────────────────────
    return new Response(
      JSON.stringify({
        success:           finalStatus !== 'error',
        import_id:         importId,
        fund_name:         fundName,
        fund_document:     fundDocument,
        reference_date:    referenceDate,
        total_rows:        dataRows.length,
        imported_rows:     importedRows,
        rejected_rows:     rejectedRows,
        status:            finalStatus,
        // Retorna até 20 erros/avisos para exibição no frontend
        errors:            errors.slice(0, 20),
        message:           `${importedRows} de ${dataRows.length} registros importados com sucesso.`,
        duplicate_warning: duplicateWarning,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[import-estoque-fidc] Erro não tratado:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
