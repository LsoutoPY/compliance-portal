/**
 * Edge Function: import-despesas-fundo
 *
 * Aceita upload de arquivos via multipart/form-data e importa lançamentos de
 * despesas operacionais de fundos na tabela `despesas_fundo`.
 *
 * Formatos suportados:
 *   1. CSV  (extrato caixa CVPAR/FIP)     — separador ";"
 *   2. XLS  (Rel. Mensal Despesas Intrag) — planilha Itaú/Intrag
 *   3. XLSX (extrato caixa BTG)           — planilha BTG
 *
 * Uso:
 *   POST /functions/v1/import-despesas-fundo
 *   Content-Type: multipart/form-data
 *   Body: campo "files" com 1..N arquivos
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Supabase client ───────────────────────────────────────────────────────────
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// ── Tipos ─────────────────────────────────────────────────────────────────────
interface DespesaRecord {
  fundo_cnpj:           string | null;
  fundo_codigo:         string | null;
  fundo_nome:           string;
  data_lancamento:      string;   // ISO date "YYYY-MM-DD"
  mes_ano:              string;   // "MM/YYYY"
  descricao_lancamento: string;
  tipo_lancamento:      string | null;
  valor:                number;
  categoria_despesa:    string;
  fonte:                string;
  arquivo_nome:         string;
  natural_key:          string;
}

// ── Categorização ─────────────────────────────────────────────────────────────
// Códigos BTG exatos são listados primeiro para garantir match antes dos padrões genéricos.
const CATEGORIA_KEYWORDS: Array<{ regex: RegExp; categoria: string }> = [
  // Códigos exatos BTG / administradoras (match prioritário)
  { regex: /\btxadministra\b|\btxadm\b/i,                    categoria: 'taxa_administracao' },
  { regex: /\btxgestao\b|\btxgest\b/i,                       categoria: 'taxa_gestao'        },
  { regex: /\btxcustod\b/i,                                  categoria: 'taxa_custodia'      },
  { regex: /\btarifbanc\b/i,                                 categoria: 'tarifa_banco'       },
  { regex: /\btxanbima\b|\btxanb\b/i,                        categoria: 'taxa_anbima'        },
  { regex: /\btxcetip\b|\btxb3\b/i,                          categoria: 'taxa_cetip'         },
  { regex: /\btxselic\b/i,                                   categoria: 'taxa_selic'         },
  // Padrões genéricos por texto livre
  { regex: /taxa.*adm|adm.*taxa|tx.*adm|recolh.*adm/i,      categoria: 'taxa_administracao' },
  { regex: /taxa.*gest|gest.*taxa|tx.*gest|recolh.*gest/i,   categoria: 'taxa_gestao'        },
  { regex: /taxa.*custod|custod.*taxa|tx.*custod/i,          categoria: 'taxa_custodia'      },
  { regex: /anbim|anbid|tx.*anbim/i,                         categoria: 'taxa_anbima'        },
  { regex: /cetip|b3.*taxa|taxa.*b3/i,                       categoria: 'taxa_cetip'         },
  { regex: /selic.*taxa|taxa.*selic|tx.*selic/i,             categoria: 'taxa_selic'         },
  { regex: /tarifa|mensalidade|banco.*tarif/i,               categoria: 'tarifa_banco'       },
  { regex: /cblc|pagt.*cblc|pagamento.*cblc/i,               categoria: 'taxa_custodia'      },
  { regex: /estorno/i,                                        categoria: 'estorno'            },
  { regex: /resgate|aplica[çc]/i,                            categoria: 'operacao_titulo'    },
  { regex: /amortiza[çc]/i,                                  categoria: 'operacao_titulo'    },
];

function categorizarDespesa(descricao: string): string {
  for (const { regex, categoria } of CATEGORIA_KEYWORDS) {
    if (regex.test(descricao)) return categoria;
  }
  return 'outros_custos';
}

// ── Natural key ───────────────────────────────────────────────────────────────
function makeNaturalKey(fonte: string, fundo: string, data: string, descricao: string, valor: number): string {
  const raw = `${fonte}|${fundo}|${data}|${descricao}|${valor}`;
  // Hash simples (djb2) — suficiente para deduplicação
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h) ^ raw.charCodeAt(i);
    h = h >>> 0;
  }
  return `${fonte}_${h.toString(16)}`;
}

// ── Helpers de data ───────────────────────────────────────────────────────────
/** "02/2026" → data_lancamento "2026-02-01", mes_ano "02/2026" */
function fromMesAno(mesAno: string): { data_lancamento: string; mes_ano: string } {
  const [mm, yyyy] = mesAno.trim().split('/');
  return {
    data_lancamento: `${yyyy}-${mm.padStart(2, '0')}-01`,
    mes_ano: `${mm.padStart(2, '0')}/${yyyy}`,
  };
}

/** JS Date ou string ISO/DD/MM/YYYY → data_lancamento + mes_ano */
function fromDate(d: Date | string): { data_lancamento: string; mes_ano: string } {
  let dt: Date;
  if (typeof d === 'string') {
    // tenta DD/MM/YYYY
    const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) dt = new Date(`${m[3]}-${m[2]}-${m[1]}`);
    else dt = new Date(d);
  } else {
    dt = d;
  }
  const yyyy = dt.getFullYear();
  const mm   = String(dt.getMonth() + 1).padStart(2, '0');
  const dd   = String(dt.getDate()).padStart(2, '0');
  return {
    data_lancamento: `${yyyy}-${mm}-${dd}`,
    mes_ano: `${mm}/${yyyy}`,
  };
}

/** Remove pontos de milhar e troca vírgula decimal BR → número */
function parseBRL(s: string | number): number {
  if (typeof s === 'number') return s;
  return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
}

// ── Parser 1: CSV CVPAR ───────────────────────────────────────────────────────
/**
 * Estrutura:
 *   Linha 1 (header):   "Código";"Carteira";"Título";"Histórico";"Título CP";"Tipo";"Entrada";"Saída";"Saldo"
 *   Linha 2 (fundo):    "49892164";"FIP M4 IE";"";"";"";"";"";"";"42.353,76"
 *   Linhas seguintes:   "";"";TITULO;HISTORICO;TITULO_CP;TIPO;ENTRADA;SAIDA;SALDO
 */
function parseCsvCvpar(text: string, arquivoNome: string): DespesaRecord[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  // Extrai código e nome do fundo da linha 2
  const fundoLine = parseCsvLine(lines[1]);
  const fundoCodigo = (fundoLine[0] || '').replace(/"/g, '').trim();
  const fundoNome   = (fundoLine[1] || '').replace(/"/g, '').trim() || fundoCodigo;

  const records: DespesaRecord[] = [];
  let dataAtual = '';
  let mesAnoAtual = '';

  for (let i = 2; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]).map(c => c.replace(/"/g, '').trim());
    const titulo    = cols[2] || '';   // Código do lançamento (ex: TXGESTAO, TARIFBANC)
    const historico = cols[3] || '';   // Descrição/histórico
    const tituloCp  = cols[4] || '';   // Título da contraparte (pode estar vazio)
    const tipo      = cols[5] || '';
    const entrada   = parseBRL(cols[6] || '0');
    const saida     = parseBRL(cols[7] || '0');

    // Extrai data do histórico sempre que encontrar DD/MM/YYYY.
    // IMPORTANTE: as despesas podem aparecer ANTES do marcador "Líquido no Dia",
    // portanto a data pode estar embutida na própria linha de despesa
    // (ex: "Pgto Despesa 04/03/2026"). Não pulamos a linha se ela tiver lançamento.
    const mData = historico.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (mData) {
      const d = fromDate(mData[1]);
      dataAtual  = d.data_lancamento;
      mesAnoAtual = d.mes_ano;
      // Linha puramente de marcador (sem lançamento associado) → pula
      if (!titulo && !tituloCp) continue;
      // Linha tem data inline E lançamento → continua o processamento abaixo
    }
    // Pula linhas sem data ainda
    if (!dataAtual) continue;
    // Pula marcadores de saldo/líquido (não são lançamentos)
    if (historico && (historico.startsWith('Saldo') || historico.startsWith('Líquido'))) continue;
    // Aceita linha se tiver Título (código) OU Título CP (historico pode ser vazio em linhas de continuação)
    if (!titulo && !tituloCp) continue;

    const valor = entrada > 0 ? entrada : -saida;
    if (valor === 0) continue;

    // Usa o código (Título) como identificador principal quando disponível.
    // descricao combina o código + texto livre para máxima informação.
    const descPrimaria = tituloCp || titulo || historico;
    const descricao = titulo && titulo !== descPrimaria
      ? `${titulo} — ${descPrimaria}`
      : descPrimaria;
    const categoria = categorizarDespesa(titulo + ' ' + historico + ' ' + descPrimaria);

    records.push({
      fundo_cnpj:           null,
      fundo_codigo:         fundoCodigo || null,
      fundo_nome:           fundoNome,
      data_lancamento:      dataAtual,
      mes_ano:              mesAnoAtual,
      descricao_lancamento: descricao,
      tipo_lancamento:      tipo || null,
      valor,
      categoria_despesa:    categoria,
      fonte:                'cvpar_csv',
      arquivo_nome:         arquivoNome,
      natural_key:          makeNaturalKey('cvpar_csv', fundoCodigo || fundoNome, dataAtual, descPrimaria, valor),
    });
  }
  return records;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ';' && !inQuote) { result.push(cur); cur = ''; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

// ── Parser 2: XLS Intrag ──────────────────────────────────────────────────────
/**
 * Colunas (linha 1 = header):
 *   0: Carteira/Fundo  1: Descrição Da Carteira/Fundo  2: Descrição do Lançamento
 *   3: Tipo de Lançamento  4: Mês/Ano Liquidação  5: Valor Lançamento
 */
function parseXlsIntrag(wb: XLSX.WorkBook, arquivoNome: string): DespesaRecord[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });

  const records: DespesaRecord[] = [];
  for (const row of rows) {
    const codigo   = String(row['Carteira/Fundo']               ?? row[Object.keys(row)[0]] ?? '').trim();
    const nome     = String(row['Descri\u00e7\u00e3o Da Carteira/Fundo'] ?? row[Object.keys(row)[1]] ?? '').trim();
    const descricao = String(row['Descri\u00e7\u00e3o do Lan\u00e7amento'] ?? row[Object.keys(row)[2]] ?? '').trim();
    const tipoLanc  = String(row['Tipo de Lan\u00e7amento'] ?? row[Object.keys(row)[3]] ?? '').trim();
    const mesAno    = String(row['M\u00eas/Ano Liquida\u00e7\u00e3o'] ?? row[Object.keys(row)[4]] ?? '').trim();
    const valorRaw  = row['Valor Lan\u00e7amento'] ?? row[Object.keys(row)[5]] ?? 0;
    const valor     = typeof valorRaw === 'number' ? valorRaw : parseBRL(String(valorRaw));

    if (!codigo || !mesAno || isNaN(valor) || valor === 0) continue;
    // Pula linha de cabeçalho que pode ter sido parseada como dado
    if (codigo.toLowerCase().includes('carteira') || codigo.toLowerCase().includes('fundo')) continue;

    const datas = fromMesAno(mesAno);

    // Inclui tipoLanc na categorização mesmo quando descricao está preenchida,
    // pois o código do lançamento (ex: TXGESTAO, TXCUSTOD) pode estar só no tipo.
    const descFinal = descricao || tipoLanc || 'Lançamento';
    const categoria = categorizarDespesa(tipoLanc + ' ' + descFinal);

    records.push({
      fundo_cnpj:           null,
      fundo_codigo:         codigo || null,
      fundo_nome:           nome || codigo,
      data_lancamento:      datas.data_lancamento,
      mes_ano:              datas.mes_ano,
      descricao_lancamento: descFinal,
      tipo_lancamento:      tipoLanc || null,
      valor,
      categoria_despesa:    categoria,
      fonte:                'intrag_xls',
      arquivo_nome:         arquivoNome,
      natural_key:          makeNaturalKey('intrag_xls', codigo, datas.data_lancamento, descFinal, valor),
    });
  }
  return records;
}

// ── Parser 3: XLSX BTG ────────────────────────────────────────────────────────
/**
 * Colunas (linha 1 = header):
 *   0: Nome da classe/subclasse  1: CNPJ da classe  2: Data
 *   3: Lançamento  4: Financeiro (R$)  5: Saldo (R$)  6: Observação  7: Remetente
 */
function parseXlsxBtg(wb: XLSX.WorkBook, arquivoNome: string): DespesaRecord[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  // BTG XLSX pode ter linhas vazias antes do cabeçalho — localiza a linha real
  const found = findHeaderRow(ws);
  if (!found) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: '',
    range: found.rowIdx, // usa a linha do cabeçalho como início; linhas anteriores ignoradas
  });

  const records: DespesaRecord[] = [];
  for (const row of rows) {
    const nome       = String(row['Nome da classe/subclasse'] ?? row[Object.keys(row)[0]] ?? '').trim();
    const cnpj       = String(row['CNPJ da classe']            ?? row[Object.keys(row)[1]] ?? '').trim();
    const dataRaw    = row['Data']                             ?? row[Object.keys(row)[2]];
    const lancamento = String(row['Lançamento']  ?? row['Lancamento'] ?? row[Object.keys(row)[3]] ?? '').trim();
    const valorRaw   = row['Financeiro (R$)']    ?? row[Object.keys(row)[4]] ?? 0;
    const obs        = String(row['Observação']  ?? row['Observacao']  ?? row[Object.keys(row)[6]] ?? '').trim();

    if (!nome || !dataRaw || !lancamento) continue;
    if (nome.toLowerCase().includes('nome da classe')) continue; // header

    const valor = typeof valorRaw === 'number' ? valorRaw : parseBRL(String(valorRaw));
    if (isNaN(valor) || valor === 0) continue;

    let datas: { data_lancamento: string; mes_ano: string };
    if (dataRaw instanceof Date) {
      datas = fromDate(dataRaw);
    } else if (typeof dataRaw === 'number') {
      // Excel serial date
      const d = XLSX.SSF.parse_date_code(dataRaw as number);
      datas = fromDate(new Date(d.y, d.m - 1, d.d));
    } else {
      datas = fromDate(String(dataRaw));
    }

    const descFinal = lancamento + (obs && obs !== ' ' ? ` — ${obs}` : '');
    const categoria = categorizarDespesa(lancamento + ' ' + obs);

    records.push({
      fundo_cnpj:           cnpj || null,
      fundo_codigo:         null,
      fundo_nome:           nome,
      data_lancamento:      datas.data_lancamento,
      mes_ano:              datas.mes_ano,
      descricao_lancamento: descFinal,
      tipo_lancamento:      null,
      valor,
      categoria_despesa:    categoria,
      fonte:                'btg_xlsx',
      arquivo_nome:         arquivoNome,
      natural_key:          makeNaturalKey('btg_xlsx', cnpj || nome, datas.data_lancamento, lancamento, valor),
    });
  }
  return records;
}

// ── Helper: encontra a primeira linha com conteúdo real ───────────────────────
/**
 * Varre até 20 linhas da planilha para encontrar a primeira com ≥ 3 células
 * não-vazias (ex.: BTG XLSX tem linha 1 vazia antes do cabeçalho).
 */
function findHeaderRow(ws: XLSX.WorkSheet): { headers: string[]; rowIdx: number } | null {
  const allRows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
    header: 1,
    defval: null,
  });
  for (let i = 0; i < Math.min(20, allRows.length); i++) {
    const row = allRows[i] as (string | number | null)[];
    const nonEmpty = row.filter(c => c != null && String(c).trim() !== '');
    if (nonEmpty.length >= 3) {
      return {
        headers: row.map(h => String(h ?? '').toLowerCase().trim()),
        rowIdx: i,
      };
    }
  }
  return null;
}

// ── Detector de formato ───────────────────────────────────────────────────────
/**
 * Detecta o formato do arquivo com base na extensão e no conteúdo.
 * Retorna 'csv' | 'intrag_xls' | 'btg_xlsx' | 'unknown'
 */
function detectFormat(fileName: string, wb: XLSX.WorkBook | null, csvText: string | null): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'csv') return 'csv';

  if (wb) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const found = findHeaderRow(ws);
    if (!found) return 'unknown';
    const headers = found.headers;

    // BTG: tem coluna "cnpj da classe"
    if (headers.some(h => h.includes('cnpj'))) return 'btg_xlsx';

    // Intrag: tem coluna "carteira/fundo"
    if (headers.some(h => h.includes('carteira') || h.includes('fundo'))) return 'intrag_xls';
  }
  return 'unknown';
}

// ── Enriquecimento: resolve CNPJ por nome do fundo ────────────────────────────
/**
 * Para registros sem fundo_cnpj (ex: Intrag XLS, CSV CVPAR), tenta resolver o
 * CNPJ procurando em fundos_caracteristicas e posicao_carteira por similaridade
 * de nome. Usa um fragmento significativo do nome (exclui palavras genéricas).
 *
 * Estratégia:
 *   1. Remove palavras genéricas (FI, FIF, FIC, QI, CP, RESP, LIMITAD*, DE, EM, COTAS)
 *   2. Usa os primeiros 2 tokens significativos como fragmento de busca
 *   3. Só associa se o resultado for único (evita ambiguidade)
 */
async function enrichCnpj(records: DespesaRecord[]): Promise<DespesaRecord[]> {
  const semCnpj = records.filter(r => !r.fundo_cnpj);
  if (semCnpj.length === 0) return records;

  const PALAVRAS_GENERICAS = new Set([
    'fi', 'fif', 'fic', 'fip', 'fidc', 'fii', 'fiagro',
    'qi', 'cp', 'resp', 'limitada', 'limitad', 'de', 'em',
    'cotas', 'fundo', 'investimento', 'multimercado', 'acoes',
    'renda', 'fixa', 'credito', 'privado', 'credito privado',
    'responsabilidade', 'lp', 'longo', 'prazo',
  ]);

  // Extrai tokens significativos de um nome
  function tokensSignificativos(nome: string): string[] {
    return nome
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !PALAVRAS_GENERICAS.has(t));
  }

  // Mapa: fundo_nome -> cnpj resolvido
  const cnpjPorNome: Record<string, string | null> = {};
  const nomesUnicos = [...new Set(semCnpj.map(r => r.fundo_nome))];

  for (const nome of nomesUnicos) {
    const tokens = tokensSignificativos(nome);
    if (tokens.length === 0) { cnpjPorNome[nome] = null; continue; }

    // Usa os dois primeiros tokens significativos como âncoras de busca
    const fragmento = tokens.slice(0, 2).join('%');
    const pattern = `%${fragmento}%`;

    // Tenta em fundos_caracteristicas primeiro
    const { data: fc } = await supabase
      .from('fundos_caracteristicas')
      .select('cnpj_fundo, cnpj_classe, nome_comercial')
      .ilike('nome_comercial', pattern)
      .limit(3);

    if (fc && fc.length === 1) {
      cnpjPorNome[nome] = fc[0].cnpj_fundo || fc[0].cnpj_classe || null;
      console.log(`[enrichCnpj] "${nome}" → ${cnpjPorNome[nome]} (via fundos_caracteristicas)`);
      continue;
    }

    // Fallback: tenta em posicao_carteira (distinct por CNPJ)
    const { data: pc } = await supabase
      .from('posicao_carteira')
      .select('fundo_cnpj, fundo_nome')
      .ilike('fundo_nome', pattern)
      .limit(3);

    const cnpjsUnicos = [...new Set((pc ?? []).map(r => r.fundo_cnpj).filter(Boolean))];
    if (cnpjsUnicos.length === 1) {
      cnpjPorNome[nome] = cnpjsUnicos[0];
      console.log(`[enrichCnpj] "${nome}" → ${cnpjPorNome[nome]} (via posicao_carteira)`);
    } else {
      cnpjPorNome[nome] = null;
      if (cnpjsUnicos.length > 1) {
        console.warn(`[enrichCnpj] "${nome}" → múltiplos CNPJs, não associado: ${cnpjsUnicos.join(', ')}`);
      }
    }
  }

  return records.map(r => ({
    ...r,
    fundo_cnpj: r.fundo_cnpj ?? cnpjPorNome[r.fundo_nome] ?? null,
  }));
}

// ── Upsert em lotes ───────────────────────────────────────────────────────────
async function upsertRecords(records: DespesaRecord[]): Promise<{ inserted: number; skipped: number }> {
  if (records.length === 0) return { inserted: 0, skipped: 0 };

  const BATCH = 250;
  let inserted = 0;
  let skipped  = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error, data } = await supabase
      .from('despesas_fundo')
      .upsert(batch, { onConflict: 'natural_key', ignoreDuplicates: true })
      .select('id');

    if (error) {
      console.error('Upsert error:', error.message, error.details);
      skipped += batch.length;
    } else {
      inserted += (data?.length ?? 0);
      skipped  += batch.length - (data?.length ?? 0);
    }
  }
  return { inserted, skipped };
}

// ── Handler principal ─────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(JSON.stringify({ error: 'Envie os arquivos via multipart/form-data' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const formData = await req.formData();
    const fileEntries = formData.getAll('files');

    if (fileEntries.length === 0) {
      return new Response(JSON.stringify({ error: 'Nenhum arquivo recebido no campo "files"' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const summary: Array<{
      arquivo: string;
      formato: string;
      total: number;
      inserted: number;
      skipped: number;
      erros: string[];
    }> = [];

    for (const entry of fileEntries) {
      if (!(entry instanceof File)) continue;

      const fileName  = entry.name;
      const erros: string[] = [];
      let records: DespesaRecord[] = [];
      let formato = 'unknown';

      try {
        const buffer = await entry.arrayBuffer();
        const bytes  = new Uint8Array(buffer);
        const ext    = fileName.split('.').pop()?.toLowerCase();

        if (ext === 'csv') {
          formato = 'cvpar_csv';
          // Tenta UTF-8 primeiro, depois latin-1
          let text: string;
          try {
            text = new TextDecoder('utf-8').decode(bytes);
          } catch {
            text = new TextDecoder('latin1').decode(bytes);
          }
          records = parseCsvCvpar(text, fileName);

        } else if (ext === 'xls' || ext === 'xlsx') {
          const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
          formato  = detectFormat(fileName, wb, null);

          if (formato === 'btg_xlsx') {
            records = parseXlsxBtg(wb, fileName);
          } else if (formato === 'intrag_xls') {
            records = parseXlsIntrag(wb, fileName);
          } else {
            erros.push(`Formato não reconhecido para "${fileName}". Esperado: Intrag XLS ou BTG XLSX.`);
          }
        } else {
          erros.push(`Extensão não suportada: .${ext}. Use .csv, .xls ou .xlsx`);
        }

        if (records.length > 0) {
          // Remove registros anteriores do mesmo arquivo para garantir reimportação limpa.
          // Isso evita o problema de "já existente" ao reimportar com correções.
          const { error: delError } = await supabase
            .from('despesas_fundo')
            .delete()
            .eq('arquivo_nome', fileName);
          if (delError) {
            console.warn(`[import] Aviso ao limpar registros de "${fileName}": ${delError.message}`);
          }

          // Tenta resolver CNPJ para registros sem fundo_cnpj (Intrag XLS, CSV CVPAR)
          const enriched = await enrichCnpj(records);
          const { inserted, skipped } = await upsertRecords(enriched);
          summary.push({ arquivo: fileName, formato, total: enriched.length, inserted, skipped, erros });
        } else {
          summary.push({ arquivo: fileName, formato, total: 0, inserted: 0, skipped: 0, erros });
        }

      } catch (err) {
        erros.push(`Erro ao processar "${fileName}": ${(err as Error).message}`);
        summary.push({ arquivo: fileName, formato, total: 0, inserted: 0, skipped: 0, erros });
      }
    }

    const totalInserted = summary.reduce((s, r) => s + r.inserted, 0);
    const totalRecords  = summary.reduce((s, r) => s + r.total, 0);

    return new Response(JSON.stringify({
      ok: true,
      total_arquivos:  summary.length,
      total_registros: totalRecords,
      total_importados: totalInserted,
      arquivos: summary,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Fatal error:', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
