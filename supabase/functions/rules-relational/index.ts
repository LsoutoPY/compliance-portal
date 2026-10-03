import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Types
type RuleStatus = 'ok' | 'alerta' | 'violacao';

interface RuleResult {
  regra_codigo: string;
  regra_descricao: string;
  status: RuleStatus;
  valor_atual: number | null;
  valor_limite: number | null;
  detalhes?: Record<string, unknown>;
}

interface RuleCheckRequest {
  fundo_cnpj: string;
  fundo_isin?: string;  // ISIN discriminator for multi-class funds (optional)
  fundo_dtposicao: string;
}

interface RuleCheckResponse {
  success: boolean;
  results: RuleResult[];
  error?: string;
}

interface RuleDefinition {
  id: string;
  codigo: string;
  descricao: string;
  parametros: Record<string, any>;
}

interface FundoRegra {
  id: string;
  fundo_cnpj: string;
  regra_id: string;
  ativo: boolean;
  regras_compliance: RuleDefinition;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

function fundoRegrasIsinQueryValues(fundoIsin?: string | null): string[] {
  const isin = fundoIsin ?? '';
  return isin ? [isin, ''] : [''];
}

function resolveFundoRegrasForIsin<T extends { fundo_isin?: string | null; regra_id: string }>(
  rows: T[] | null | undefined,
  fundoIsin?: string | null,
): T[] {
  const isin = fundoIsin ?? '';
  const applicable = (rows ?? []).filter((r) => {
    const rowIsin = r.fundo_isin ?? '';
    return rowIsin === '' || rowIsin === isin;
  });
  const byRegra = new Map<string, T>();
  for (const row of applicable) {
    const rowIsin = row.fundo_isin ?? '';
    const existing = byRegra.get(row.regra_id);
    if (!existing) {
      byRegra.set(row.regra_id, row);
      continue;
    }
    if (rowIsin !== '' && (existing.fundo_isin ?? '') === '') {
      byRegra.set(row.regra_id, row);
    }
  }
  return Array.from(byRegra.values());
}

// Save results to database
async function saveResults(
  fundo_cnpj: string,
  fundo_isin: string,
  fundo_dtposicao: string,
  categoria: string,
  results: RuleResult[]
) {
  const records = results.map((r) => ({
    fundo_cnpj,
    fundo_isin,
    fundo_dtposicao,
    regra_categoria: categoria,
    regra_codigo: r.regra_codigo,
    regra_descricao: r.regra_descricao,
    status: r.status,
    valor_atual: r.valor_atual,
    valor_limite: r.valor_limite,
    detalhes: r.detalhes || null,
  }));

  // Delete previous results for this category to avoid stale data
  await supabase
    .from('enquadramento_resultado')
    .delete()
    .eq('fundo_cnpj', fundo_cnpj)
    .eq('fundo_isin', fundo_isin)
    .eq('fundo_dtposicao', fundo_dtposicao)
    .eq('regra_categoria', categoria);

  if (results.length === 0) return;

  // Upsert to handle re-runs
  const { error } = await supabase
    .from('enquadramento_resultado')
    .upsert(records, {
      onConflict: 'fundo_cnpj,fundo_isin,fundo_dtposicao,regra_codigo',
    });

  if (error) {
    console.error('Error saving results:', error);
    throw error;
  }
}

/**
 * Edge Function: rules-relational
 * 
 * Verifies relational rules (manually associated with funds) for a fund at a specific date.
 */
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { fundo_cnpj, fundo_isin: fundo_isin_req, fundo_dtposicao }: RuleCheckRequest = await req.json();
    const fundo_isin = fundo_isin_req ?? '';

    if (!fundo_cnpj || !fundo_dtposicao) {
      return new Response(
        JSON.stringify({ success: false, error: 'fundo_cnpj and fundo_dtposicao are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Limpa o CNPJ de qualquer máscara ou espaço
    const cleanCnpj = fundo_cnpj.replace(/\D/g, '');
    
    console.log(`[rules-relational] Checking fund ${fundo_cnpj} (clean: ${cleanCnpj}) for date ${fundo_dtposicao}`);

    // 1. Fetch active rules for this fund
    const { data: fundRulesRaw, error: rulesError } = await supabase
      .from('fundo_regras')
      .select(`
        id,
        fundo_cnpj,
        fundo_isin,
        regra_id,
        ativo,
        regras_compliance (
          id,
          codigo,
          descricao,
          parametros
        )
      `)
      .eq('fundo_cnpj', cleanCnpj)
      .in('fundo_isin', fundoRegrasIsinQueryValues(fundo_isin))
      .eq('ativo', true)
      .eq('status_aprovacao', 'ativo');

    const fundRules = resolveFundoRegrasForIsin(fundRulesRaw, fundo_isin);

    if (rulesError) {
      console.error('[rules-relational] Error fetching fund rules:', rulesError);
      return new Response(
        JSON.stringify({ success: false, error: `Error fetching fund rules: ${rulesError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!fundRules || fundRules.length === 0) {
      console.log(`[rules-relational] No active relational rules found for fund ${cleanCnpj}`);
      return new Response(
        JSON.stringify({ success: true, results: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[rules-relational] Found ${fundRules.length} active rules for fund ${cleanCnpj}`);

    // 2. Fetch fund portfolio (posicao_carteira)
    let assetsQuery = supabase
      .from('posicao_carteira')
      .select('*')
      .eq('fundo_cnpj', fundo_cnpj)
      .eq('fundo_dtposicao', fundo_dtposicao);
    if (fundo_isin) assetsQuery = assetsQuery.eq('fundo_isin', fundo_isin);
    const { data: assets, error: assetsError } = await assetsQuery;

    if (assetsError) throw assetsError;
    
    if (!assets || assets.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'No position data found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const patliq = assets[0].fundo_patliq || 0;
    const results: RuleResult[] = [];

    // 3. Pre-fetch necessary data for rules
    // Collect all CNPJs from assets that are funds (cotas)
    const assetCnpjs = assets
      .filter(a => a.section === 'cotas' && a.cnpjfundo)
      .map(a => a.cnpjfundo as string);
    
    const uniqueAssetCnpjs = [...new Set(assetCnpjs)];
    const assetCharacteristicsMap = new Map<string, any>();
    const registryNameMap = new Map<string, string>();
    // Map: target fund cnpj (key) -> cnpjadm of that fund (for mesma_administradora check)
    const assetAdminMap = new Map<string, string>();

    const toCnpjKey = (v: string | number) => String(v).replace(/\D/g, '').padStart(14, '0');
    const cnpjNumbers = uniqueAssetCnpjs
      .map((c) => parseInt(c.replace(/\D/g, ''), 10))
      .filter((n) => !Number.isNaN(n));

    if (uniqueAssetCnpjs.length > 0) {
      const { data: assetCharsClasse } = await supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, caracteristica_investidor, nome_comercial')
        .in('cnpj_classe', uniqueAssetCnpjs);
      const { data: assetCharsFundo } = await supabase
        .from('fundos_caracteristicas')
        .select('cnpj_classe, cnpj_fundo, caracteristica_investidor, nome_comercial')
        .in('cnpj_fundo', uniqueAssetCnpjs);
      const assetChars = [...(assetCharsClasse || []), ...(assetCharsFundo || [])];

      if (assetChars?.length) {
        assetChars.forEach((char: any) => {
          if (char.cnpj_classe) assetCharacteristicsMap.set(toCnpjKey(char.cnpj_classe), char);
          if (char.cnpj_fundo && char.cnpj_fundo !== char.cnpj_classe) {
            assetCharacteristicsMap.set(toCnpjKey(char.cnpj_fundo), char);
          }
        });
      }

      if (cnpjNumbers.length > 0) {
        const { data: regFundos } = await supabase
          .from('registro_fundo')
          .select('cnpj_fundo, denominacao_social')
          .in('cnpj_fundo', cnpjNumbers);
        regFundos?.forEach((r: any) => {
          if (r.denominacao_social) registryNameMap.set(toCnpjKey(r.cnpj_fundo), r.denominacao_social);
        });
        const { data: regClasses } = await supabase
          .from('registro_classe')
          .select('cnpj_classe, denominacao_social')
          .in('cnpj_classe', cnpjNumbers);
        regClasses?.forEach((r: any) => {
          if (r.denominacao_social) registryNameMap.set(toCnpjKey(r.cnpj_classe), r.denominacao_social);
        });
      }

      // Pre-fetch administrator info for target funds from posicao_carteira
      // We look for the most recent record of each target fund to obtain fundo_cnpjadm
      const { data: targetFundRecords } = await supabase
        .from('posicao_carteira')
        .select('fundo_cnpj, fundo_cnpjadm')
        .in('fundo_cnpj', uniqueAssetCnpjs)
        .not('fundo_cnpjadm', 'is', null)
        .order('fundo_dtposicao', { ascending: false })
        .limit(uniqueAssetCnpjs.length * 5);

      if (targetFundRecords?.length) {
        // Keep only the first (most recent) entry per fund cnpj
        const seen = new Set<string>();
        targetFundRecords.forEach((r: any) => {
          const key = toCnpjKey(r.fundo_cnpj);
          if (!seen.has(key) && r.fundo_cnpjadm) {
            seen.add(key);
            assetAdminMap.set(key, toCnpjKey(r.fundo_cnpjadm));
          }
        });
      }
    }

    // Administrator CNPJ of the investing fund (from its own posicao_carteira records)
    const investingFundCnpjAdm = assets.find(a => a.fundo_cnpjadm)?.fundo_cnpjadm
      ? toCnpjKey(assets.find(a => a.fundo_cnpjadm)!.fundo_cnpjadm)
      : null;

    const getAssetNome = (cnpj: string, char: any, posicao: any) =>
      char?.nome_comercial ||
      registryNameMap.get(toCnpjKey(cnpj)) ||
      posicao?.nome_comercial_ativo ||
      cnpj;

    // 4. Execute each rule
    for (const ruleAssoc of fundRules) {
      const rule = ruleAssoc.regras_compliance;
      // Use type assertion since Supabase returns it as array or object depending on query
      const ruleDef = Array.isArray(rule) ? rule[0] : rule; 
      
      if (!ruleDef) continue;

      console.log(`[rules-relational] Executing rule ${ruleDef.codigo}`);

      // Handle all rules of tipo_regra "limite_por_tipo_investidor"
      // (previously identified only by hardcoded code "LIMITE_PROFISSIONAL_10")
      const tipoRegra = ruleDef.parametros?.tipo_regra;
      const isLimitePorTipoInvestidor =
        tipoRegra === 'limite_por_tipo_investidor' ||
        ruleDef.codigo === 'LIMITE_PROFISSIONAL_10'; // retrocompat

      if (isLimitePorTipoInvestidor) {
        const limitParam = ruleDef.parametros.limite || 0.10;
        const targetType = ruleDef.parametros.tipo_investidor || 'Profissional';
        const nivel1Categoria = ruleDef.parametros.nivel1_categoria as string | undefined;
        const mesmaAdministradora = ruleDef.parametros.mesma_administradora === true;

        // Filter assets that match all conditions
        const matchingAssets = assets.filter(a => {
          if (a.section !== 'cotas' || !a.cnpjfundo) return false;

          const cnpjKey = toCnpjKey(a.cnpjfundo);
          const char = assetCharacteristicsMap.get(cnpjKey);

          // Must match the required investor type
          if (!char || char.caracteristica_investidor !== targetType) return false;

          // Optional: filter by nivel1_categoria
          if (nivel1Categoria && char.nivel1_categoria !== nivel1Categoria) return false;

          // Optional: filter by same administrator
          if (mesmaAdministradora) {
            if (!investingFundCnpjAdm) return false; // can't determine — skip
            const targetAdm = assetAdminMap.get(cnpjKey);
            if (!targetAdm) return false; // administrator unknown — skip
            if (targetAdm !== investingFundCnpjAdm) return false;
          }

          return true;
        });

        const totalValue = matchingAssets.reduce((sum, a) => sum + (a.valor_padrao || 0), 0);
        const percentage = patliq > 0 ? totalValue / patliq : 0;

        let status: RuleStatus = 'ok';
        if (percentage > limitParam) {
          status = 'violacao';
        }

        results.push({
          regra_codigo: ruleDef.codigo,
          regra_descricao: ruleDef.descricao,
          status,
          valor_atual: percentage,
          valor_limite: limitParam,
          detalhes: {
            total_investido: totalValue,
            patliq,
            tipo_alvo: targetType,
            nivel1_categoria: nivel1Categoria || null,
            mesma_administradora: mesmaAdministradora,
            cnpjadm_fundo_investidor: investingFundCnpjAdm || null,
            ativos_contabilizados: matchingAssets.map(a => ({
              nome: getAssetNome(a.cnpjfundo, assetCharacteristicsMap.get(toCnpjKey(a.cnpjfundo)), a),
              cnpj: a.cnpjfundo,
              valor: a.valor_padrao,
              percentual: patliq > 0 ? (a.valor_padrao || 0) / patliq : 0,
              tipo_investidor: assetCharacteristicsMap.get(toCnpjKey(a.cnpjfundo))?.caracteristica_investidor,
              cnpjadm: assetAdminMap.get(toCnpjKey(a.cnpjfundo)) || null,
            }))
          }
        });
      }
      // Add more cases here for other relational rule types
    }

    // Save results
    await saveResults(fundo_cnpj, fundo_isin, fundo_dtposicao, 'relacional', results);

    const response: RuleCheckResponse = {
      success: true,
      results,
    };

    console.log(`[rules-relational] Completed check for ${fundo_cnpj}. Results:`, results);

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[rules-relational] Unexpected error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
