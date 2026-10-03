import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CVM_BASE_URL = 'https://dados.cvm.gov.br/dados/FIP/DOC/INF_QUADRIMESTRAL/DADOS';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

function toCnpjKey(cnpj: string): string {
  return String(cnpj).replace(/\D/g, '').padStart(14, '0');
}

interface ImportRequest {
  ano?: number;
  anos?: number[];
}

interface ImportResponse {
  success: boolean;
  imported: number;
  errors: string[];
  ano?: number;
}

/**
 * Edge Function: import-fip-informe-quadrimestral
 *
 * Baixa o CSV do Informe Quadrimestral FIP da CVM e importa para a tabela fip_informe_quadrimestral.
 * Pode receber ano único ou array de anos.
 */
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body: ImportRequest = await req.json().catch(() => ({}));
    const anos: number[] = body.anos ?? (body.ano != null ? [body.ano] : [new Date().getFullYear()]);

    const errors: string[] = [];
    let totalImported = 0;

    for (const ano of anos) {
      const csvUrl = `${CVM_BASE_URL}/inf_quadrimestral_fip_${ano}.csv`;

      let csvText: string;
      try {
        const resp = await fetch(csvUrl, { headers: { 'Accept': 'text/csv, text/plain' } });
        if (!resp.ok) {
          errors.push(`Ano ${ano}: CVM retornou ${resp.status}`);
          continue;
        }
        csvText = await resp.text();
      } catch (e) {
        errors.push(`Ano ${ano}: Erro de rede - ${String(e)}`);
        continue;
      }

      const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        errors.push(`Ano ${ano}: CSV vazio ou sem dados`);
        continue;
      }

      const headers = lines[0].split(';').map((h) => h.trim());
      const cnpjIdx = headers.findIndex((h) => h === 'CNPJ_FUNDO_CLASSE');
      const vlCapIdx = headers.findIndex((h) => h === 'VL_CAP_SUBSCR');
      const dtIdx = headers.findIndex((h) => h === 'DT_COMPTC');
      const denomIdx = headers.findIndex((h) => h === 'DENOM_SOCIAL');

      if (cnpjIdx < 0 || vlCapIdx < 0) {
        errors.push(`Ano ${ano}: Colunas CNPJ_FUNDO_CLASSE ou VL_CAP_SUBSCR não encontradas`);
        continue;
      }

      const seen = new Set<string>();
      const rows: { cnpj_fundo_classe: string; dt_comptc: string; vl_cap_subscr: number; denom_social: string | null }[] = [];

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(';');
        const cnpjRaw = parts[cnpjIdx] ?? '';
        const cnpjNorm = toCnpjKey(cnpjRaw);
        if (cnpjNorm.length !== 14) continue;

        const vlCapStr = (parts[vlCapIdx] ?? '').replace(',', '.');
        const vlCap = parseFloat(vlCapStr);
        if (Number.isNaN(vlCap) || vlCap < 0) continue;

        const dtStr = dtIdx >= 0 ? (parts[dtIdx] ?? '').trim() : '';
        if (!dtStr || !/^\d{4}-\d{2}-\d{2}$/.test(dtStr)) continue;

        const key = `${cnpjNorm}|${dtStr}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const denom = denomIdx >= 0 ? (parts[denomIdx] ?? '').trim() || null : null;

        rows.push({
          cnpj_fundo_classe: cnpjNorm,
          dt_comptc: dtStr,
          vl_cap_subscr: vlCap,
          denom_social: denom || null,
        });
      }

      if (rows.length === 0) {
        errors.push(`Ano ${ano}: Nenhum registro válido`);
        continue;
      }

      const { error } = await supabase
        .from('fip_informe_quadrimestral')
        .upsert(
          rows.map((r) => ({
            cnpj_fundo_classe: r.cnpj_fundo_classe,
            dt_comptc: r.dt_comptc,
            vl_cap_subscr: r.vl_cap_subscr,
            denom_social: r.denom_social,
            ano_referencia: ano,
          })),
          { onConflict: 'cnpj_fundo_classe,dt_comptc' }
        );

      if (error) {
        errors.push(`Ano ${ano}: ${error.message}`);
      } else {
        totalImported += rows.length;
      }
    }

    return new Response(
      JSON.stringify({
        success: errors.length === 0,
        imported: totalImported,
        errors,
      } as ImportResponse),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, imported: 0, errors: [String(e)] } as ImportResponse),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
