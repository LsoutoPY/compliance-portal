/**
 * Edge Function: import-fundos-caracteristicas
 *
 * Recebe registros já normalizados pelo browser (parseAnbimaXlsx em ImportXml.tsx).
 * UPSERT por codigo_anbima; INSERT para linhas sem código.
 *
 * POST application/json: { records: FundoRecord[], filename?: string }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/** Acima disso o runtime tende a estourar tempo/memória ao dar JSON.parse no corpo. */
const MAX_JSON_BODY_BYTES = 2_500_000;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

interface FundoRecord {
  codigo_anbima: string | null;
  estrutura: string | null;
  nome_comercial: string | null;
  denominacao_social: string | null;
  cnpj_classe: string | null;
  cnpj_fundo: string | null;
  isin: string | null;
  status: string | null;
  data_inicio_atividade: string | null;
  quantidade_subclasses: number | null;
  categoria_anbima: string | null;
  tipo_anbima: string | null;
  composicao_fundo: string | null;
  aberto_estatutariamente: string | null;
  fundo_esg: string | null;
  tributacao_alvo: string | null;
  administrador: string | null;
  gestor_principal: string | null;
  primeiro_aporte: string | null;
  tipo_investidor: string | null;
  caracteristica_investidor: string | null;
  cota_abertura: string | null;
  aplicacao_inicial_minima: number | null;
  prazo_pagamento_resgate_dias: number | null;
  adaptado_175: string | null;
  codigo_cvm_subclasse: string | null;
  foco_atuacao: string | null;
  nivel1_categoria: string | null;
  nivel2_categoria: string | null;
  nivel3_subcategoria: string | null;
  updated_at: string;
}

/** Impede que datas absurdas (ex.: ano 29222) quebrem o driver Postgres ("time zone displacement out of range"). */
function sanitizeSqlDateField(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  const t = String(v).trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (!Number.isFinite(y) || y < 1900 || y > 2100) return null;
  return t;
}

function sanitizeFundoRecord(r: FundoRecord): FundoRecord {
  const cod = r.codigo_anbima != null ? String(r.codigo_anbima).trim().toUpperCase() : null;
  return {
    ...r,
    codigo_anbima: cod === '' ? null : cod,
    data_inicio_atividade: sanitizeSqlDateField(r.data_inicio_atividade),
    primeiro_aporte: sanitizeSqlDateField(r.primeiro_aporte),
  };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            'Este endpoint não aceita upload do arquivo .xlsx. Atualize o aplicativo: a planilha é lida no navegador e enviados apenas lotes JSON de registros (~150–400 linhas).',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (!contentType.includes('application/json')) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Envie application/json com { records: FundoRecord[], filename?: string }.',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const cl = req.headers.get('content-length');
    if (cl != null) {
      const bytes = parseInt(cl, 10);
      if (!Number.isNaN(bytes) && bytes > MAX_JSON_BODY_BYTES) {
        return new Response(
          JSON.stringify({
            success: false,
            error:
              `Corpo muito grande (${bytes} bytes). Indica cliente desatualizado enviando a planilha inteira. Publique o front-end atual (import em lotes) ou use o repositório mais recente. Limite por requisição: ${MAX_JSON_BODY_BYTES} bytes.`,
          }),
          { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    const body = await req.json() as { records?: FundoRecord[]; filename?: string };
    const records: FundoRecord[] = (body.records ?? []).map(sanitizeFundoRecord);
    const fileName = body.filename ?? 'planilha.xlsx';

    console.log(`[import-fundos-caracteristicas] ${fileName}: lote com ${records.length} registros`);

    if (records.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Nenhum registro no lote.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const BATCH_SIZE = 80;
    let upserted = 0;
    let inserted = 0;
    let batchCom: FundoRecord[] = [];
    let batchSem: FundoRecord[] = [];

    const flushCom = async () => {
      if (batchCom.length === 0) return;
      const { error } = await supabase
        .from('fundos_caracteristicas')
        .upsert(batchCom, { onConflict: 'codigo_anbima' });
      if (error) throw new Error(`Erro no upsert: ${error.message}`);
      upserted += batchCom.length;
      batchCom = [];
    };

    const flushSem = async () => {
      if (batchSem.length === 0) return;
      const { error } = await supabase.from('fundos_caracteristicas').insert(batchSem);
      if (error) {
        throw new Error(
          `Insert sem código ANBIMA falhou (${batchSem.length} linha(s)): ${error.message}. ` +
            'Todas as linhas da planilha pública devem ter código ANBIMA (C…/S…) para atualizar subclasses; ' +
            'se o erro citar chave única em CNPJ, aplique a migração que usa unicidade em codigo_anbima.',
        );
      }
      inserted += batchSem.length;
      batchSem = [];
    };

    for (const rec of records) {
      if (rec.codigo_anbima) {
        batchCom.push(rec);
        if (batchCom.length >= BATCH_SIZE) await flushCom();
      } else {
        batchSem.push(rec);
        if (batchSem.length >= BATCH_SIZE) await flushSem();
      }
    }

    await flushCom();
    await flushSem();

    const total = upserted + inserted;
    console.log(
      `[import-fundos-caracteristicas] lote OK: ${upserted} upsert + ${inserted} insert = ${total}`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        filename: fileName,
        summary: {
          total,
          upserted_com_codigo_anbima: upserted,
          inserted_sem_codigo_anbima: inserted,
        },
        message: `Lote: ${upserted} atualizados/inseridos (código ANBIMA), ${inserted} sem código.`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[import-fundos-caracteristicas]', err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
