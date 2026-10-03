import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ── Mapeamento: código Economatica → CNPJ ───────────────────────────────────
// Apenas fundos conhecidos. Fundos novos NÃO precisam estar aqui para importar —
// a validação só bloqueia quando o código aponta explicitamente para um CNPJ diferente.
const CODIGO_PARA_CNPJ: Record<string, string> = {
  '663980': '45653388000168', // QI CP PLUS FC FIDC
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseBrDate(value: string): string | null {
  const m = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseBrNumber(value: string): number | null {
  const clean = value.trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

/**
 * Extrai o código numérico do cabeçalho da planilha Economatica.
 * Padrão: "663980 - NOME DO FUNDO"
 */
function extrairCodigoPlanilha(html: string): string | null {
  const m = html.match(/(\d{5,7})\s*-\s*[A-Z]/);
  return m ? m[1] : null;
}

/**
 * Verifica se o arquivo corresponde ao CNPJ informado.
 *
 * Lógica de três casos:
 *  1. Código extraído aponta para CNPJ diferente → BLOQUEIA (arquivo errado)
 *  2. Código extraído aponta para o mesmo CNPJ  → OK (match confirmado)
 *  3. Código não encontrado ou não mapeado       → PERMITE com aviso (fundo novo)
 *
 * Retorna { ok: true } ou { ok: false, motivo: string }
 */
function checarArquivoVsCnpj(
  codigo: string | null,
  cnpjInformado: string,
): { ok: boolean; aviso?: string } {
  if (!codigo) {
    // Não foi possível extrair o código — fundo novo ou formato ligeiramente diferente
    return { ok: true, aviso: 'Código não encontrado no cabeçalho — importando sem validação de código.' };
  }
  const cnpjMapeado = CODIGO_PARA_CNPJ[codigo];
  if (!cnpjMapeado) {
    // Código presente mas ainda não cadastrado no mapa — fundo novo
    return { ok: true, aviso: `Código ${codigo} não está no mapeamento — importando sem confirmação de CNPJ.` };
  }
  if (cnpjMapeado !== cnpjInformado) {
    // Código presente E mapeado para um CNPJ diferente → arquivo errado
    return {
      ok: false,
      aviso: `Arquivo pertence ao CNPJ "${cnpjMapeado}" (código ${codigo}), mas foi informado "${cnpjInformado}". Selecione o fundo correto.`,
    };
  }
  return { ok: true };
}

/**
 * Parse da tabela HTML do arquivo XLS exportado da Economatica.
 * Retorna linhas de dados (exclui cabeçalhos e linhas sem colunas suficientes).
 */
function parseHtmlTabelaCotas(html: string): { data: string; preco: string }[] {
  const resultado: { data: string; preco: string }[] = [];

  // Extrai todas as linhas <tr>
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];

    // Extrai células <td>
    const cells: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(
        tdMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .trim(),
      );
    }

    if (cells.length < 2) continue;

    // Linha de dados: primeira célula é data BR, segunda é número decimal
    const candidataData = cells[0];
    const candidataPreco = cells[1];

    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(candidataData)) continue;
    if (!candidataPreco || candidataPreco.trim() === '-' || candidataPreco.trim() === '') continue;

    resultado.push({ data: candidataData, preco: candidataPreco });
  }

  return resultado;
}

interface RentabilidadeRow {
  cnpj: string;
  data_ref: string;
  cota: number;
  ret_1d: number | null;
  ret_21d: number | null;
  ret_252d: number | null;
  fonte: string;
}

/**
 * Calcula retornos aritméticos (pct_change) — IDÊNTICO ao script Python.
 *
 * Python:
 *   g["ret_1d"]   = g["cota"].pct_change()    # (P_t / P_{t-1}) - 1
 *   g["ret_21d"]  = g["cota"].pct_change(21)
 *   g["ret_252d"] = g["cota"].pct_change(252)
 *
 * Eventos corporativos (|ret_1d| > 50%) zereram ret_1d, ret_21d e ret_252d
 * para não distorcer o VaR — replicando o filtro do script.
 */
function calcularRetornos(
  cotas: { data: string; cota: number }[],
  cnpj: string,
): { rows: RentabilidadeRow[]; eventosFiltrados: number } {
  const sorted = [...cotas].sort((a, b) => a.data.localeCompare(b.data));
  let eventosFiltrados = 0;

  const rows: RentabilidadeRow[] = sorted.map((row, i) => {
    const ret_1d = i >= 1 ? row.cota / sorted[i - 1].cota - 1 : null;
    const ret_21d = i >= 21 ? row.cota / sorted[i - 21].cota - 1 : null;
    const ret_252d = i >= 252 ? row.cota / sorted[i - 252].cota - 1 : null;

    const eventoCorpo = ret_1d !== null && Math.abs(ret_1d) > 0.50;
    if (eventoCorpo) eventosFiltrados++;

    return {
      cnpj,
      data_ref: row.data,
      cota: row.cota,
      ret_1d: eventoCorpo ? null : ret_1d,
      ret_21d: eventoCorpo ? null : ret_21d,
      ret_252d: eventoCorpo ? null : ret_252d,
      fonte: 'historico_manual',
    };
  });

  return { rows, eventosFiltrados };
}

// ── Handler principal ────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Envie o arquivo via multipart/form-data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const cnpjInformado = (formData.get('cnpj') as string | null)?.replace(/\D/g, '') ?? '';
    const dataCorteRaw = (formData.get('data_corte') as string | null) ?? '';

    // ── Validações de entrada ─────────────────────────────────────────────
    if (!file) {
      return new Response(
        JSON.stringify({ success: false, error: 'Campo "file" não encontrado' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (!cnpjInformado || cnpjInformado.length !== 14) {
      return new Response(
        JSON.stringify({ success: false, error: `CNPJ inválido: "${cnpjInformado}" (esperado 14 dígitos)` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataCorteRaw)) {
      return new Response(
        JSON.stringify({ success: false, error: `data_corte inválida: "${dataCorteRaw}" (esperado YYYY-MM-DD)` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Leitura e parse do arquivo ────────────────────────────────────────
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Economatica exporta HTML com encoding latin1
    const html = new TextDecoder('latin1').decode(bytes);

    // ── Validar que o arquivo NÃO pertence a um fundo diferente ──────────
    // Bloqueia apenas se o código da planilha mapeia explicitamente para outro CNPJ.
    // Códigos desconhecidos ou não mapeados são permitidos (fundo novo).
    // Executa ANTES de qualquer DELETE no banco.
    const codigoPlanilha = extrairCodigoPlanilha(html);
    const validacao = checarArquivoVsCnpj(codigoPlanilha, cnpjInformado);
    if (!validacao.ok) {
      return new Response(
        JSON.stringify({ success: false, error: validacao.aviso }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (validacao.aviso) {
      console.warn('[importar-historico-manual]', validacao.aviso);
    }

    // ── Parse da tabela de cotas ──────────────────────────────────────────
    const linhasRaw = parseHtmlTabelaCotas(html);
    if (linhasRaw.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhuma linha de dados encontrada na planilha' }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Converte datas e preços; descarta linhas inválidas
    const cotas: { data: string; cota: number }[] = [];
    for (const linha of linhasRaw) {
      const dataIso = parseBrDate(linha.data);
      const cota = parseBrNumber(linha.preco);
      if (!dataIso || cota === null || cota <= 0) continue;

      // Filtro de data de corte: importa apenas dados ANTERIORES à data de corte
      // (a série CVM a partir da data de corte é mantida intacta)
      if (dataIso >= dataCorteRaw) continue;

      cotas.push({ data: dataIso, cota });
    }

    if (cotas.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Nenhum dado válido encontrado anterior a data_corte=${dataCorteRaw}`,
        }),
        { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const periodoInicio = cotas.reduce((min, r) => r.data < min ? r.data : min, cotas[0].data);
    const periodoFim = cotas.reduce((max, r) => r.data > max ? r.data : max, cotas[0].data);

    // ── Cálculo de retornos aritméticos ───────────────────────────────────
    const { rows: rentabilidade, eventosFiltrados } = calcularRetornos(cotas, cnpjInformado);

    // ── Contar dias CVM existentes (para estatísticas) ────────────────────
    const { count: diasCvm } = await supabase
      .from('rentabilidade_fundos')
      .select('*', { count: 'exact', head: true })
      .eq('cnpj', cnpjInformado)
      .gte('data_ref', dataCorteRaw);

    // ── DELETE registros históricos (apenas APÓS validação) ───────────────
    const { error: deleteError } = await supabase
      .from('rentabilidade_fundos')
      .delete()
      .eq('cnpj', cnpjInformado)
      .lt('data_ref', dataCorteRaw);

    if (deleteError) throw deleteError;

    // ── UPSERT em lotes de 500 ────────────────────────────────────────────
    const BATCH = 500;
    let totalInserido = 0;
    for (let i = 0; i < rentabilidade.length; i += BATCH) {
      const lote = rentabilidade.slice(i, i + BATCH);
      const { error: upsertError } = await supabase
        .from('rentabilidade_fundos')
        .upsert(lote, { onConflict: 'cnpj,data_ref' });
      if (upsertError) throw upsertError;
      totalInserido += lote.length;
    }

    // ── Contar série final ────────────────────────────────────────────────
    const { count: totalFinal } = await supabase
      .from('rentabilidade_fundos')
      .select('*', { count: 'exact', head: true })
      .eq('cnpj', cnpjInformado);

    return new Response(
      JSON.stringify({
        success: true,
        cnpj: cnpjInformado,
        periodo_planilha: { inicio: periodoInicio, fim: periodoFim },
        total_dias_importados: totalInserido,
        dias_merged_cvm: diasCvm ?? 0,
        total_serie_final: totalFinal ?? 0,
        eventos_corporativos_filtrados: eventosFiltrados,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[importar-historico-manual]', err);
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
