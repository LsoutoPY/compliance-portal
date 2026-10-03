/**
 * Edge Function: import-matriz-anbima
 *
 * Aceita upload apenas da Matriz ANBIMA (report_fliq_*.csv)
 * via multipart/form-data no campo "file".
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

// --- Matriz helpers ---
function parseValor(v: string): number {
  const s = String(v).trim();
  if (!s) return 0;
  if (s.includes('E') || s.includes('e')) return parseFloat(s);
  return parseFloat(s.replace(',', '.')) || 0;
}

function parseData(dataStr: string): string {
  return dataStr.trim().replace(/\//g, '-');
}

function parseCsv(content: string): Array<Record<string, unknown>> {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const records: Array<Record<string, unknown>> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length < 8) continue;

    const data = values[0]?.trim() || '';
    const periodo = values[1]?.trim() || '';
    const classe = values[2]?.trim() || '';
    const segmento = values[3]?.trim() || '';
    const metodologia = values[4]?.trim() || '';
    const metrica = values[5]?.trim() || '';
    const prazo = parseInt(values[6]?.trim() || '0', 10);
    const valor = parseValor(values[7] || '0');

    if (!data || !periodo || isNaN(prazo)) continue;

    records.push({
      data_ref: parseData(data),
      periodo,
      classe,
      segmento_investidor: segmento,
      tipo_metodologia: metodologia,
      metrica,
      prazo,
      valor,
    });
  }

  return records;
}

serve(async (req: Request) => {
  console.log('[import-matriz-anbima] Recebendo requisição:', req.method);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';

    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Content-Type deve ser multipart/form-data. Envie o arquivo CSV no campo "file".',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const formData = await req.formData();

    // --- MATRIZ ANBIMA ---
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Nenhum arquivo enviado. Use o campo "file" no form-data.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const filename = file.name;
    console.log('[import-matriz-anbima] Processando:', filename);

    const content = await file.text();
    const records = parseCsv(content);

    if (records.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Nenhum registro válido encontrado no CSV. Verifique o formato (data,periodo,classe,segmento_investidor,tipo_metodologia,metrica,prazo,valor).',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const BATCH = 200;
    let total = 0;

    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const { error } = await supabase.from('matriz_anbima').upsert(batch, {
        onConflict: 'periodo,classe,segmento_investidor,tipo_metodologia,metrica,prazo',
      });

      if (error) {
        console.error('[import-matriz-anbima] Erro no batch:', error);
        return new Response(
          JSON.stringify({
            success: false,
            error: `Erro ao inserir dados: ${error.message}`,
            inserted: total,
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      total += batch.length;
    }

    console.log('[import-matriz-anbima] Importados', total, 'registros');

    return new Response(
      JSON.stringify({
        success: true,
        filename,
        recordsInserted: total,
        message: `Matriz ANBIMA atualizada com sucesso. ${total} registros importados.`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[import-matriz-anbima] Erro:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
