import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function saveResults(
  fundo_cnpj: string,
  fundo_dtposicao: string,
  categoria: string,
  results: Array<{
    regra_codigo: string;
    regra_descricao: string;
    status: string;
    valor_atual: number | null;
    valor_limite: number | null;
    detalhes?: Record<string, unknown>;
  }>
) {
  const records = results.map((r) => ({
    fundo_cnpj,
    fundo_dtposicao,
    regra_categoria: categoria,
    regra_codigo: r.regra_codigo,
    regra_descricao: r.regra_descricao,
    status: r.status,
    valor_atual: r.valor_atual,
    valor_limite: r.valor_limite,
    detalhes: r.detalhes || null,
  }));

  // Upsert to handle re-runs
  const { error } = await supabase
    .from('enquadramento_resultado')
    .upsert(records, {
      onConflict: 'fundo_cnpj,fundo_dtposicao,regra_codigo',
    });

  if (error) {
    console.error('Error saving results:', error);
    throw error;
  }
}
