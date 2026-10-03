/**
 * buscar-risco-mercado-v2
 * =======================
 * Edge Function que retorna duas visões de risco de mercado:
 *
 *  carteiras[]
 *    Métricas da própria série de cota de cada carteira
 *    (fonte: controle_cotas_metricas via vw_risco_mercado_carteiras)
 *    Inclui: VaR EWMA 95%, Drawdown, Pior 21d, Stress Pior.
 *    V2: adiciona VaR Param, VaR MC(t), VaR Diversif, B-VaR calculados
 *    via posicao_diaria × betas_por_cnpj (ponderados por saldo).
 *
 *  fundos[]
 *    Fundos identificados via posicao_carteira (XMLs importados diariamente).
 *    V2: inclui VaR Param, VaR MC(t), B-VaR por CNPJ.
 *
 *  summary
 *    Agregados globais: PL Total, VaR Aditivo vs Diversificado,
 *    benefício de diversificação, cobertura, status breakdown.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// ─── helpers ──────────────────────────────────────────────────────────────

async function fetchAll<T>(
  query: ReturnType<typeof supabase.from>,
  pageSize = 1000,
): Promise<T[]> {
  const result: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await (query as any).range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    result.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return result;
}

// ─── tipos ────────────────────────────────────────────────────────────────

interface CarteiraMetricaRow {
  cliente: string;
  data_posicao: string;
  var_mes_95: number | null;
  drawdown_atual_pct: number | null;
  drawdown_max_252d_pct: number | null;
  pior_21d_pct: number | null;
  retorno_ate_21d_simples: number | null;
  desvio_padrao_janela: number | null;
  alerta_3sigma: boolean | null;
  cod_cli: number | null;
  grupo: string | null;
}

interface FundoMetricaRow {
  cnpj: string;
  nome_fundo: string | null;
  var_95_21d: number | null;
  var_99_21d: number | null;
  pior_21d_pct: number | null;
  drawdown_atual_pct: number | null;
  drawdown_max_252d_pct: number | null;
  n_obs_21d: number | null;
  data_base_calculo: string | null;
  qualidade: string | null;
  // V2 — nulos até script Python rodar
  var_95_param: number | null;
  var_99_param: number | null;
  cvar_95_param: number | null;
  var_95_mc_t: number | null;
  cvar_95_mc_t: number | null;
  bvar_95: number | null;
  benchmark_cod: string | null;
  rho_benchmark: number | null;
  tracking_error: number | null;
  df_t: number | null;
  fonte: string | null;
}

interface PosCartRow {
  fundo_cnpj: string;
  nome_fundo: string | null;
  fundo_dtposicao: string | null;
}

interface StressRow {
  cod_cli: number;
  perda_pct: number | null;
  pl_atual: number | null;
  pl_estressado: number | null;
}

interface PosicaoDiariaRow {
  cod_cli: number;
  nom_atv: string;
  nom_estr: string | null;
  cnpj: string | null;
  cnpj_status: string | null;
  sld_lqd: number;
}

interface BetaV2Row {
  cnpj: string;
  nome_fundo: string | null;
  qualidade: string | null;
  r2: number | null;
  n_obs: number | null;
  n_obs_21d: number | null;
  var_95_21d: number | null;
  var_99_21d: number | null;
  pior_21d_pct: number | null;
  var_95_param: number | null;
  cvar_95_param: number | null;
  var_95_mc_t: number | null;
  cvar_95_mc_t: number | null;
  var_95_diversif: number | null;
  bvar_95: number | null;
  benchmark_cod: string | null;
  rho_benchmark: number | null;
  tracking_error: number | null;
  df_t: number | null;
}

interface LimiteRow {
  cod_cli: number;
  limite_95: number;
  limite_99: number;
}

interface VarSerieRow {
  cod_cli: number;
  data_ref: string;
  var_95_hist: number | null;
  var_95_param: number | null;
  var_95_mc_t: number | null;
  var_95_diversif: number | null;
  pl_total: number | null;
}

// ─── handler ──────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const dataParam = url.searchParams.get('data_posicao');
    if (dataParam && !ISO_DATE_RE.test(dataParam)) {
      return new Response(
        JSON.stringify({ success: false, error: 'data_posicao inválida — use YYYY-MM-DD' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    // ── 1. Métricas de carteiras (VaR EWMA, Drawdown) ────────────────────
    let carteiraMetricas: CarteiraMetricaRow[] = [];
    let carteiraMetricasLoaded = false;

    try {
      const rows = await fetchAll<CarteiraMetricaRow>(
        supabase
          .from('vw_risco_mercado_carteiras')
          .select(
            'cliente,data_posicao,var_mes_95,drawdown_atual_pct,drawdown_max_252d_pct,' +
            'pior_21d_pct,retorno_ate_21d_simples,desvio_padrao_janela,alerta_3sigma,cod_cli,grupo',
          ),
      );
      carteiraMetricas = rows;
      carteiraMetricasLoaded = true;
    } catch (_) {
      // view não existe — tenta fallback direto na tabela
    }

    if (!carteiraMetricasLoaded) {
      try {
        type RawMetrica = {
          cliente: string; data_posicao: string; var_mes_95: number | null;
          retorno_ate_21d_simples: number | null; desvio_padrao_janela: number | null;
          alerta_3sigma: boolean | null;
          drawdown_atual_pct?: number | null; drawdown_max_252d_pct?: number | null;
          pior_21d_pct?: number | null;
        };

        let allRows: RawMetrica[] = [];
        try {
          allRows = await fetchAll<RawMetrica>(
            supabase
              .from('controle_cotas_metricas')
              .select(
                'cliente,data_posicao,var_mes_95,retorno_ate_21d_simples,' +
                'desvio_padrao_janela,alerta_3sigma,' +
                'drawdown_atual_pct,drawdown_max_252d_pct,pior_21d_pct',
              )
              .order('data_posicao', { ascending: false }),
          );
        } catch (_dd) {
          allRows = await fetchAll<RawMetrica>(
            supabase
              .from('controle_cotas_metricas')
              .select(
                'cliente,data_posicao,var_mes_95,retorno_ate_21d_simples,' +
                'desvio_padrao_janela,alerta_3sigma',
              )
              .order('data_posicao', { ascending: false }),
          );
        }

        const latestMap = new Map<string, RawMetrica>();
        for (const r of allRows) {
          if (!latestMap.has(r.cliente)) latestMap.set(r.cliente, r);
        }

        carteiraMetricas = [...latestMap.values()].map((r) => ({
          cliente: r.cliente, data_posicao: r.data_posicao,
          var_mes_95: r.var_mes_95 ?? null,
          drawdown_atual_pct: r.drawdown_atual_pct ?? null,
          drawdown_max_252d_pct: r.drawdown_max_252d_pct ?? null,
          pior_21d_pct: r.pior_21d_pct ?? null,
          retorno_ate_21d_simples: r.retorno_ate_21d_simples ?? null,
          desvio_padrao_janela: r.desvio_padrao_janela ?? null,
          alerta_3sigma: r.alerta_3sigma ?? null,
          cod_cli: null, grupo: null,
        }));
      } catch (__) {
        console.error('[buscar-risco-mercado-v2] fallback controle_cotas_metricas falhou', __);
      }
    }

    // ── 2. Lookup de carteiras ────────────────────────────────────────────
    type CartRow = { cod_cli: number; nome: string; grupo: string | null };
    const cartRows = await fetchAll<CartRow>(
      supabase.from('carteiras').select('cod_cli,nome,grupo'),
    );
    const cartByCodCli = new Map<number, CartRow>(cartRows.map((c) => [c.cod_cli, c]));
    const cartByNome   = new Map<string, CartRow>(cartRows.map((c) => [c.nome, c]));

    // ── 3. Stress mais recente por carteira ──────────────────────────────
    const stressMap = new Map<number, number>();
    {
      const { data: latestStress } = await supabase
        .from('resultado_stress')
        .select('data_calculo')
        .order('data_calculo', { ascending: false })
        .limit(1);
      const dataStress = latestStress?.[0]?.data_calculo ?? null;

      if (dataStress) {
        const stressRows = await fetchAll<StressRow>(
          supabase
            .from('resultado_stress')
            .select('cod_cli,perda_pct,pl_atual,pl_estressado')
            .eq('data_calculo', dataStress),
        );
        for (const s of stressRows) {
          const perdaCalc =
            s.pl_atual && s.pl_estressado != null
              ? ((s.pl_estressado / s.pl_atual) - 1) * 100 : 0;
          const perda = s.perda_pct ?? perdaCalc;
          const atual = stressMap.get(s.cod_cli) ?? 0;
          if (perda < atual) stressMap.set(s.cod_cli, perda);
        }
      }
    }

    // ── 4. Data de posição (parâmetro ou última em posicao_diaria) ───────
    let ultimaDataPosicao: string | null = dataParam;
    if (!ultimaDataPosicao) {
      try {
        const { data: dpRow } = await supabase
          .from('posicao_diaria')
          .select('data_posicao')
          .order('data_posicao', { ascending: false })
          .limit(1);
        ultimaDataPosicao = dpRow?.[0]?.data_posicao ?? null;
      } catch (_) { /* tabela pode não existir */ }
    }

    // ── 5. Posições diárias + betas V2 para calcular VaR por carteira ────
    //    VaR Aditivo: soma(sld_lqd × var_pct) / pl_total por cod_cli
    const varPorCarteira = new Map<number, {
      pl_total: number; pl_com_var: number;
      var_95_hist_rs: number; var_95_param_rs: number;
      var_95_mc_t_rs: number; var_95_diversif_rs: number;
      bvar_95_rs: number;
      fundos_detalhe: Array<{
        nom_atv: string; nom_estr: string | null; cnpj: string | null;
        sld_lqd: number; pct_pl: number;
        var_95_hist_pct: number | null; var_95_param_pct: number | null;
        var_95_mc_t_pct: number | null; bvar_95_pct: number | null;
        qualidade: string | null; r2: number | null; n_obs: number | null;
        benchmark_cod: string | null; rho_benchmark: number | null;
        tracking_error: number | null; df_t: number | null;
      }>;
    }>();

    if (ultimaDataPosicao) {
      // Carrega posições
      let posRows: PosicaoDiariaRow[] = [];
      try {
        posRows = await fetchAll<PosicaoDiariaRow>(
          supabase
            .from('posicao_diaria')
            .select('cod_cli,nom_atv,nom_estr,cnpj,cnpj_status,sld_lqd')
            .eq('data_posicao', ultimaDataPosicao)
            .gt('sld_lqd', 0),
        );
      } catch (_) { /* posicao_diaria não disponível */ }

      // Carrega betas V2 com fallback sem novas colunas
      let betaMap = new Map<string, BetaV2Row>();
      try {
        const betas = await fetchAll<BetaV2Row>(
          supabase
            .from('betas_por_cnpj')
            .select(
              'cnpj,nome_fundo,qualidade,r2,n_obs,n_obs_21d,' +
              'var_95_21d,var_99_21d,pior_21d_pct,' +
              'var_95_param,cvar_95_param,var_95_mc_t,cvar_95_mc_t,' +
              'var_95_diversif,bvar_95,benchmark_cod,rho_benchmark,' +
              'tracking_error,df_t',
            ),
        );
        betaMap = new Map(betas.map((b) => [b.cnpj, b]));
      } catch (_) {
        // Fallback sem colunas V2 (migration não aplicada ainda)
        try {
          type BetaLegacy = { cnpj: string; nome_fundo: string | null; qualidade: string | null; r2: number | null; n_obs: number | null; n_obs_21d: number | null; var_95_21d: number | null; var_99_21d: number | null; pior_21d_pct: number | null; };
          const betas = await fetchAll<BetaLegacy>(
            supabase.from('betas_por_cnpj').select('cnpj,nome_fundo,qualidade,r2,n_obs,n_obs_21d,var_95_21d,var_99_21d,pior_21d_pct'),
          );
          betaMap = new Map(betas.map((b) => [b.cnpj, {
            ...b, var_95_param: null, cvar_95_param: null, var_95_mc_t: null,
            cvar_95_mc_t: null, var_95_diversif: null, bvar_95: null,
            benchmark_cod: null, rho_benchmark: null, tracking_error: null, df_t: null,
          }]));
        } catch (__) { /* sem betas */ }
      }

      // Agrupa por carteira
      const posGrupo = new Map<number, PosicaoDiariaRow[]>();
      for (const p of posRows) {
        const arr = posGrupo.get(p.cod_cli) ?? [];
        arr.push(p);
        posGrupo.set(p.cod_cli, arr);
      }

      for (const [codCli, ativos] of posGrupo) {
        const plTotal = ativos.reduce((s, a) => s + (a.sld_lqd ?? 0), 0);
        if (plTotal <= 0) continue;

        let plComVar = 0;
        let var95HistRs = 0, var95ParamRs = 0, var95McTRs = 0;
        let var95DiversifRs = 0, bvar95Rs = 0;
        const fundosDetalhe: typeof varPorCarteira extends Map<any, infer V> ? V['fundos_detalhe'] : never[] = [];

        for (const a of ativos) {
          const usarBeta = a.cnpj && a.cnpj_status && ['OK', 'DUPLICADO_14D'].includes(a.cnpj_status ?? '');
          const beta = usarBeta && a.cnpj ? (betaMap.get(a.cnpj) ?? null) : null;
          const peso = a.sld_lqd / plTotal;

          if (beta?.var_95_21d != null) {
            var95HistRs += a.sld_lqd * beta.var_95_21d;
            plComVar += a.sld_lqd;
          }
          if (beta?.var_95_param != null) var95ParamRs += a.sld_lqd * beta.var_95_param;
          if (beta?.var_95_mc_t  != null) var95McTRs   += a.sld_lqd * beta.var_95_mc_t;
          if (beta?.var_95_diversif != null) var95DiversifRs += a.sld_lqd * beta.var_95_diversif;
          if (beta?.bvar_95 != null) bvar95Rs += a.sld_lqd * beta.bvar_95;

          fundosDetalhe.push({
            nom_atv: a.nom_atv, nom_estr: a.nom_estr, cnpj: a.cnpj,
            sld_lqd: a.sld_lqd, pct_pl: peso * 100,
            var_95_hist_pct:  beta?.var_95_21d  != null ? beta.var_95_21d  * 100 : null,
            var_95_param_pct: beta?.var_95_param != null ? beta.var_95_param * 100 : null,
            var_95_mc_t_pct:  beta?.var_95_mc_t  != null ? beta.var_95_mc_t  * 100 : null,
            bvar_95_pct:      beta?.bvar_95      != null ? beta.bvar_95      * 100 : null,
            qualidade: beta?.qualidade ?? null, r2: beta?.r2 ?? null, n_obs: beta?.n_obs ?? null,
            benchmark_cod: beta?.benchmark_cod ?? null,
            rho_benchmark: beta?.rho_benchmark ?? null,
            tracking_error: beta?.tracking_error ?? null,
            df_t: beta?.df_t ?? null,
          });
        }

        varPorCarteira.set(codCli, {
          pl_total: plTotal, pl_com_var: plComVar,
          var_95_hist_rs: var95HistRs, var_95_param_rs: var95ParamRs,
          var_95_mc_t_rs: var95McTRs, var_95_diversif_rs: var95DiversifRs,
          bvar_95_rs: bvar95Rs,
          fundos_detalhe: fundosDetalhe.sort((a, b) => b.sld_lqd - a.sld_lqd),
        });
      }
    }

    // ── 6. Limites de VaR por carteira ───────────────────────────────────
    const limitesMap = new Map<number, { limite_95: number; limite_99: number }>();
    try {
      const limiteRows = await fetchAll<LimiteRow>(
        supabase.from('var_limites').select('cod_cli,limite_95,limite_99').eq('ativo', true),
      );
      for (const l of limiteRows) limitesMap.set(l.cod_cli, { limite_95: l.limite_95, limite_99: l.limite_99 });
    } catch (_) { /* tabela pode não existir ainda */ }

    // ── 7. Série histórica de VaR por carteira (últimos 12 meses) ────────
    const serieMap = new Map<number, VarSerieRow[]>();
    try {
      const hoje = new Date();
      const anoAtras = new Date(hoje);
      anoAtras.setFullYear(anoAtras.getFullYear() - 1);
      const dataInicio = anoAtras.toISOString().split('T')[0];
      const dataFim    = hoje.toISOString().split('T')[0];

      const serieRows = await fetchAll<VarSerieRow>(
        supabase
          .from('var_historico_carteira')
          .select('cod_cli,data_ref,var_95_hist,var_95_param,var_95_mc_t,var_95_diversif,pl_total')
          .gte('data_ref', dataInicio)
          .lte('data_ref', dataFim)
          .order('data_ref', { ascending: true }),
      );
      for (const r of serieRows) {
        const arr = serieMap.get(r.cod_cli) ?? [];
        arr.push(r);
        serieMap.set(r.cod_cli, arr);
      }
    } catch (_) { /* tabela pode não existir ainda */ }

    // ── 8. Montar visão CARTEIRAS ─────────────────────────────────────────
    let totalPl = 0, totalVar95HistRs = 0, totalVar95DiversifRs = 0;
    let nOk = 0, nAlerta = 0, nBreach = 0;
    let piorCarteiraVarPct: number | null = null;
    let coberturaAcum = 0;

    const carteirasOut = carteiraMetricas.map((cm) => {
      const codCli = cm.cod_cli ?? cartByNome.get(cm.cliente)?.cod_cli ?? null;
      const cart   = codCli ? cartByCodCli.get(codCli) : cartByNome.get(cm.cliente);
      const v2     = codCli ? (varPorCarteira.get(codCli) ?? null) : null;
      const limites = codCli ? (limitesMap.get(codCli) ?? null) : null;
      const serie  = codCli ? (serieMap.get(codCli) ?? []) : [];
      const dataRefCarteira = cm.data_posicao ?? ultimaDataPosicao ?? null;
      const serieRef = dataRefCarteira
        ? (serie.find((s) => s.data_ref === dataRefCarteira) ?? (serie.length ? serie[serie.length - 1] : null))
        : (serie.length ? serie[serie.length - 1] : null);

      const plTotal = v2?.pl_total ?? 0;
      const plComVar = v2?.pl_com_var ?? 0;
      const coberturaPct = plTotal > 0 ? plComVar / plTotal : 0;

      const var95HistPct  = plTotal > 0 && v2 ? (v2.var_95_hist_rs  / plTotal) * 100 : null;
      const var95ParamPct = plTotal > 0 && v2 ? (v2.var_95_param_rs / plTotal) * 100 : null;
      const var95McTPct   = plTotal > 0 && v2 ? (v2.var_95_mc_t_rs  / plTotal) * 100 : null;
      // V2: prioriza var_historico_carteira (cálculo diversificado por carteira),
      // e usa agregação por betas como fallback de compatibilidade.
      const var95DivRsSerie = (serieRef?.var_95_diversif != null)
        ? (serieRef.var_95_diversif * (serieRef.pl_total ?? plTotal))
        : null;
      const var95DivRsFallback = v2?.var_95_diversif_rs ?? null;
      const var95DivRs = var95DivRsSerie ?? var95DivRsFallback;
      const var95DivPct = (serieRef?.var_95_diversif != null)
        ? (serieRef.var_95_diversif * 100)
        : (plTotal > 0 && var95DivRs != null ? (var95DivRs / plTotal) * 100 : null);
      const bvar95Pct     = plTotal > 0 && v2 ? (v2.bvar_95_rs      / plTotal) * 100 : null;
      const var95HistRs   = v2?.var_95_hist_rs     ?? null;
      const benefDivRs    = (var95HistRs != null && var95DivRs != null) ? var95HistRs - var95DivRs : null;
      const benefDivPct   = (benefDivRs != null && var95HistRs != null && var95HistRs !== 0)
                            ? (benefDivRs / Math.abs(var95HistRs)) * 100 : null;

      const limite95 = limites?.limite_95 ?? null;
      const pctUso   = (var95HistPct != null && limite95 != null)
                       ? Math.abs(var95HistPct) / (limite95 * 100) : null;

      let status = 'sem_dados';
      if (var95HistPct != null) {
        if (pctUso != null && pctUso >= 1.0) status = 'breach';
        else if (pctUso != null && pctUso >= 0.85) status = 'alerta';
        else status = 'ok';
      }

      if (status === 'ok') nOk++;
      else if (status === 'alerta') nAlerta++;
      else if (status === 'breach') nBreach++;

      if (plTotal > 0) {
        totalPl += plTotal;
        coberturaAcum += coberturaPct;
        if (var95HistRs != null)  totalVar95HistRs    += var95HistRs;
        if (var95DivRs  != null)  totalVar95DiversifRs += var95DivRs;
      }
      if (var95HistPct != null && (piorCarteiraVarPct == null || var95HistPct < piorCarteiraVarPct)) {
        piorCarteiraVarPct = var95HistPct;
      }

      return {
        cliente:               cm.cliente,
        cod_cli:               codCli,
        grupo:                 cm.grupo ?? cart?.grupo ?? null,
        data_posicao:          cm.data_posicao,
        // VaR EWMA existente
        var_mes_95_pct:        cm.var_mes_95 != null ? cm.var_mes_95 * 100 : null,
        drawdown_atual_pct:    cm.drawdown_atual_pct,
        drawdown_max_252d_pct: cm.drawdown_max_252d_pct,
        pior_21d_pct:          cm.pior_21d_pct,
        retorno_21d_atual_pct: cm.retorno_ate_21d_simples != null ? cm.retorno_ate_21d_simples * 100 : null,
        vol_diaria_pct:        cm.desvio_padrao_janela != null ? cm.desvio_padrao_janela * 100 : null,
        alerta_3sigma:         cm.alerta_3sigma ?? false,
        stress_pior_pct:       codCli != null ? (stressMap.get(codCli) ?? null) : null,
        // V2 novos
        pl_total:              plTotal || null,
        cobertura_cnpj_pct:    coberturaPct * 100,
        var_95_hist_pct:       var95HistPct,
        var_95_param_pct:      var95ParamPct,
        var_95_mc_t_pct:       var95McTPct,
        var_95_diversif_pct:   var95DivPct,
        bvar_95_pct:           bvar95Pct,
        var_95_hist_rs:        var95HistRs,
        var_95_diversif_rs:    var95DivRs,
        beneficio_diversif_rs: benefDivRs,
        beneficio_diversif_pct: benefDivPct,
        limite_95:             limite95 != null ? limite95 * 100 : null,
        pct_uso_limite:        pctUso != null ? pctUso * 100 : null,
        status,
        serie_var:             serie,
        fundos_detalhe:        v2?.fundos_detalhe ?? [],
      };
    });

    carteirasOut.sort((a, b) => {
      const ordem: Record<string, number> = { breach: 0, alerta: 1, ok: 2, sem_dados: 3 };
      const diff = (ordem[a.status] ?? 3) - (ordem[b.status] ?? 3);
      if (diff !== 0) return diff;
      return (a.var_mes_95_pct ?? 0) - (b.var_mes_95_pct ?? 0);
    });

    // ── 9. Fundos únicos da posicao_carteira (XMLs diários) ──────────────
    let posCartRows: PosCartRow[] = [];
    try {
      posCartRows = await fetchAll<PosCartRow>(
        supabase
          .from('posicao_carteira')
          .select('fundo_cnpj,nome_fundo,fundo_dtposicao')
          .not('fundo_cnpj', 'is', null)
          .order('fundo_dtposicao', { ascending: false }),
      );
    } catch (_) { /* tabela pode não existir ainda */ }

    const fundosPosCart = new Map<string, PosCartRow>();
    for (const r of posCartRows) {
      if (!r.fundo_cnpj) continue;
      if (!fundosPosCart.has(r.fundo_cnpj)) fundosPosCart.set(r.fundo_cnpj, r);
    }

    // ── 10. Métricas de fundos com colunas V2 ────────────────────────────
    let fundoMetricas: FundoMetricaRow[] = [];
    try {
      fundoMetricas = await fetchAll<FundoMetricaRow>(
        supabase
          .from('betas_por_cnpj')
          .select(
            'cnpj,nome_fundo,qualidade,n_obs_21d,' +
            'var_95_21d,var_99_21d,pior_21d_pct,' +
            'var_95_param,var_99_param,cvar_95_param,' +
            'var_95_mc_t,cvar_95_mc_t,' +
            'bvar_95,benchmark_cod,rho_benchmark,tracking_error,df_t,fonte',
          ),
      );

      // Complementa com drawdown de fundos_metricas_mercado se disponível
      try {
        type DdRow = { cnpj: string; drawdown_atual_pct: number | null; drawdown_max_252d_pct: number | null; n_obs_21d: number | null; data_base_calculo: string | null; };
        const ddRows = await fetchAll<DdRow>(
          supabase.from('fundos_metricas_mercado').select('cnpj,drawdown_atual_pct,drawdown_max_252d_pct,n_obs_21d,data_base_calculo'),
        );
        const ddMap = new Map(ddRows.map((d) => [d.cnpj, d]));
        fundoMetricas = fundoMetricas.map((f) => {
          const dd = ddMap.get(f.cnpj);
          return {
            ...f,
            drawdown_atual_pct:    dd?.drawdown_atual_pct    ?? null,
            drawdown_max_252d_pct: dd?.drawdown_max_252d_pct ?? null,
            data_base_calculo:     dd?.data_base_calculo     ?? null,
            n_obs_21d:             f.n_obs_21d               ?? dd?.n_obs_21d ?? null,
          };
        });
      } catch (_) { /* sem drawdown */ }
    } catch (_) {
      // Fallback sem colunas V2
      try {
        type BLegacy = { cnpj: string; nome_fundo: string | null; qualidade: string | null; n_obs_21d: number | null; var_95_21d: number | null; var_99_21d: number | null; pior_21d_pct: number | null; };
        const betas = await fetchAll<BLegacy>(
          supabase.from('betas_por_cnpj').select('cnpj,nome_fundo,qualidade,n_obs_21d,var_95_21d,var_99_21d,pior_21d_pct'),
        );
        fundoMetricas = betas.map((b) => ({
          ...b, drawdown_atual_pct: null, drawdown_max_252d_pct: null,
          data_base_calculo: null, var_95_param: null, var_99_param: null,
          cvar_95_param: null, var_95_mc_t: null, cvar_95_mc_t: null,
          bvar_95: null, benchmark_cod: null, rho_benchmark: null,
          tracking_error: null, df_t: null, fonte: null,
        }));
      } catch (__) { /* sem métricas de fundos */ }
    }

    const fundoMetricaMap = new Map<string, FundoMetricaRow>(
      fundoMetricas.map((f) => [f.cnpj, f]),
    );

    // ── 11. Montar visão FUNDOS ───────────────────────────────────────────
    const fundosOut = [...fundosPosCart.values()].map((pos) => {
      const cnpj = pos.fundo_cnpj;
      const m = fundoMetricaMap.get(cnpj);
      return {
        cnpj,
        nome_fundo:            m?.nome_fundo ?? pos.nome_fundo ?? cnpj,
        ultima_posicao:        pos.fundo_dtposicao,
        qualidade:             m?.qualidade ?? null,
        var_95_21d_pct:        m?.var_95_21d  != null ? m.var_95_21d  * 100 : null,
        var_99_21d_pct:        m?.var_99_21d  != null ? m.var_99_21d  * 100 : null,
        var_95_param_pct:      m?.var_95_param != null ? m.var_95_param * 100 : null,
        var_95_mc_t_pct:       m?.var_95_mc_t  != null ? m.var_95_mc_t  * 100 : null,
        bvar_95_pct:           m?.bvar_95      != null ? m.bvar_95      * 100 : null,
        benchmark_cod:         m?.benchmark_cod    ?? null,
        rho_benchmark:         m?.rho_benchmark    ?? null,
        tracking_error:        m?.tracking_error   ?? null,
        df_t:                  m?.df_t             ?? null,
        fonte_cota:            m?.fonte            ?? null,
        pior_21d_pct:          m?.pior_21d_pct     ?? null,
        drawdown_atual_pct:    m?.drawdown_atual_pct    ?? null,
        drawdown_max_252d_pct: m?.drawdown_max_252d_pct ?? null,
        n_obs_21d:             m?.n_obs_21d     ?? null,
        data_base_calculo:     m?.data_base_calculo ?? null,
        sem_metricas:          !m,
      };
    });

    fundosOut.sort((a, b) => {
      if (a.sem_metricas !== b.sem_metricas) return a.sem_metricas ? 1 : -1;
      return (a.var_95_21d_pct ?? 1) - (b.var_95_21d_pct ?? 1);
    });

    // ── 12. Summary ───────────────────────────────────────────────────────
    const nCarteiras = carteirasOut.length;
    const coberturaMedia = nCarteiras > 0 ? coberturaAcum / nCarteiras : 0;
    const benefTotal = totalVar95HistRs - totalVar95DiversifRs;
    const benefTotalPct = totalVar95HistRs !== 0 ? (benefTotal / Math.abs(totalVar95HistRs)) * 100 : 0;

    const summary = {
      total_carteiras:       nCarteiras,
      pl_total:              totalPl,
      var_95_aditivo_rs:     totalVar95HistRs,
      var_95_diversif_rs:    totalVar95DiversifRs || null,
      beneficio_diversif_rs: (totalVar95DiversifRs !== 0) ? benefTotal : null,
      beneficio_diversif_pct: (totalVar95DiversifRs !== 0) ? benefTotalPct : null,
      cobertura_media_pct:   coberturaMedia * 100,
      carteiras_ok:          nOk,
      carteiras_alerta:      nAlerta,
      carteiras_breach:      nBreach,
      pior_carteira_var_pct: piorCarteiraVarPct,
      data_posicao_risco:    ultimaDataPosicao,
    };

    // ── 13. Resposta ──────────────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        success:         true,
        total_carteiras: carteirasOut.length,
        total_fundos:    fundosOut.length,
        carteiras:       carteirasOut,
        fundos:          fundosOut,
        summary,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[buscar-risco-mercado-v2]', err);
    const errMsg = err instanceof Error
      ? err.message
      : (typeof err === 'object' ? JSON.stringify(err) : String(err));
    return new Response(
      JSON.stringify({ success: false, error: errMsg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
