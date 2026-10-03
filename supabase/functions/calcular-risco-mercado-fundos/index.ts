/**
 * Edge Function: calcular-risco-mercado-fundos
 *
 * METODOLOGIA OFICIAL V3 (Risco de Mercado — FIC/FIDC) — única fonte de cálculo.
 * Substitui qualquer fórmula divergente calculada em Python (atualizar-betas-por-cnpj.py /
 * calcular_var_completo.py) para os fundos monitorados nesta tela. Sem Monte Carlo, sem
 * betas, sem regressão, sem VaR diversificado — isso é papel do Motor de Risco de Crédito
 * (FIC/FIDC) e da aba legada "Carteiras" (V2), que permanecem intocados.
 *
 * Convenção de sinal (OFICIAL): VaR = magnitude POSITIVA de perda. VaR = 0,80% significa
 * "potencial de perda de 0,80%". NUNCA armazenar o quantil bruto (que pode ser positivo)
 * como se fosse o VaR. Drawdown também é magnitude positiva (mantido, pré-existente).
 *
 * 1) VaR Paramétrico 95% — 1 dia útil (campo oficial: var_95_param_1d_pct/rs)
 *      VaR_1d = Z_95 × σ_diário            (Z_95 = 1,645; SEM μ, SEM √21, SEM horizonte 21d)
 *
 * 2) VaR Histórico 95% — 21 dias úteis (campo oficial: var_95_hist_21d_pct/rs)
 *      R_21d(t) = Π(1 + ret_1d) − 1   (produto composto de 21 retornos diários consecutivos)
 *      P5       = percentil 5% da série de R_21d
 *      VaR_21d  = max(0, −P5)          — nunca negativo; se P5 > 0 (sem perda histórica), VaR = 0.
 *
 * Os campos legados var_95_param_pct/rs e var_95_hist_pct/rs são mantidos POPULADOS com os
 * MESMOS valores (mesma convenção positiva) apenas por compatibilidade com consumidores
 * existentes — considerar @deprecated, usar os campos _1d_/_21d_ como fonte de verdade.
 *
 * Contagem de observações:
 *   n_obs      = nº de retornos DIÁRIOS usados na janela de σ / VaR Param 1d (máx. 252).
 *   n_obs_21d  = nº de JANELAS rolling de 21d efetivamente usadas no percentil do VaR
 *                Histórico (não é nº de dias de histórico!). Para N janelas são necessários
 *                N + 21 retornos diários (equivalente a N + 22 cotas/preços).
 *
 * Fonte de cota: posicao_carteira (XML) + rentabilidade_fundos (fonte='historico_manual')
 * Fonte CDI    : historico_mercado.cdi_acum (fallback BCB SGS 12 se desatualizado)
 * Quebra de série / eventos corporativos: retornos diários com |ret| > 50% são descartados
 * (calcularRetornos) — mesmo filtro aplicado às janelas 21d compostas a partir deles.
 *
 * Body aceito:
 *   { action?: 'run' | 'setup_cron', origem?: 'cron' | 'manual' }
 *
 * action='setup_cron' : chama RPC setup_risco_mercado_fundos_cron (uma vez pós-deploy)
 * action='run'        : calcula e armazena métricas (default)
 */

const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Parâmetros de cálculo
const JANELA_DIAS_CALCULO = 120;   // dias corridos a reprocessar por run
const MAX_OBS_SIGMA       = 252;   // máximo de RETORNOS DIÁRIOS para σ / VaR Param 1d
const MIN_OBS_SIGMA       = 20;    // mínimo de obs para exibir σ / VaR Param 1d
const MIN_OBS_HIST        = 100;   // mínimo de JANELAS 21d para VaR Histórico 95%
const HORIZONTE_21D       = 21;    // tamanho da janela rolling (dias úteis/corridos)
// Para produzir até MAX_OBS_SIGMA (252) janelas rolling de 21d, calcularRetornos21d
// precisa de 252 + 21 - 1 = 272 RETORNOS DIÁRIOS de entrada (não 272 dias de cota:
// 272 retornos vêm de 273 observações de cota, já que o 1º dia não gera retorno).
// Ex.: 252 retornos diários (253 cotas) → 232 janelas 21d; 272 retornos (273 cotas) → 252 janelas.
const MAX_DIAS_VAR_HIST   = MAX_OBS_SIGMA + HORIZONTE_21D - 1; // 272
const FILTRO_RET_MAX      = 0.50;  // |ret| > 50% = evento corporativo/quebra de série — ignorar
const THRESHOLD_RELACAO   = 20;    // |Δcota| / |ΔCDI| > 20 = ATENÇÃO
const Z_95                = 1.645; // z oficial para confiança 95% (Φ⁻¹(0,95) ≈ 1,6449)
// Qualidade da série (econômica)
const DD_SUSPEITO_PCT     = 50;    // drawdown atual ou máximo acima disso marca série suspeita
const GAP_QUEBRA_DIAS     = 10;    // gap entre observações acima disso sugere quebra de série
const MIN_NOBS_1D_QUALI   = 126;   // menos de ~6 meses úteis de retornos diários = histórico baixo
const MIN_NOBS_21D_QUALI  = 100;   // menos de 100 janelas 21d = histórico baixo

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

// ── Helpers de fetch para o banco ───────────────────────────

function headers() {
  return {
    'apikey':        SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=minimal',
  };
}

async function query(path: string): Promise<unknown[]> {
  // PostgREST aplica limite padrão (geralmente 1000). Para séries longas (CDI/XML),
  // precisamos paginar para não truncar dados e distorcer resultados.
  const PAGE = 1000;
  const SEP = path.includes('?') ? '&' : '?';
  let offset = 0;
  const allRows: unknown[] = [];

  for (let i = 0; i < 1000; i++) {
    const pagedPath = `${path}${SEP}limit=${PAGE}&offset=${offset}`;
    const url = `${SUPABASE_URL}/rest/v1/${pagedPath}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`[query] ${pagedPath}: ${res.status} ${await res.text()}`);

    const rows = await res.json() as unknown[];
    allRows.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  return allRows;
}

async function rpc(fn: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fn}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: headers(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`[rpc] ${fn}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function upsertBatch(table: string, rows: Record<string, unknown>[], conflict: string) {
  if (rows.length === 0) return;
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const h   = { ...headers(), 'Prefer': `resolution=merge-duplicates,return=minimal` };
  const res = await fetch(url, {
    method:  'POST',
    headers: h,
    body:    JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`[upsert] ${table}: ${res.status} ${await res.text()}`);
}

async function updateLog(id: string, patch: Record<string, unknown>) {
  const url = `${SUPABASE_URL}/rest/v1/risco_mercado_fundos_calc_log?id=eq.${id}`;
  await fetch(url, {
    method:  'PATCH',
    headers: headers(),
    body:    JSON.stringify(patch),
  });
}

// ── Tipos internos ───────────────────────────────────────────

interface XmlRow {
  fundo_cnpj:      string;
  nome_fundo:      string | null;
  fundo_nome:      string | null;   // coluna alternativa
  fundo_dtposicao: string;          // YYYYMMDD (string, não DATE)
  fundo_patliq:    number | null;
  fundo_valorcota: number;
}

interface ManualRow {
  cnpj:     string;
  data_ref: string;   // DATE 'YYYY-MM-DD'
  cota:     number;
}

interface CdiRow {
  data:     string;   // DATE 'YYYY-MM-DD' (coluna 'data', não 'data_ref')
  cdi_acum: number;
}

interface BcbCdiRow {
  data: string;   // dd/MM/yyyy
  valor: string;  // taxa diária (%)
}

interface DiaEntry {
  data:  string;   // 'YYYY-MM-DD'
  cota:  number;
  pl:    number | null;
  fonte: 'xml' | 'manual';
}

// ── Séries de mercado ────────────────────────────────────────

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoToBcbDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function bcbDateToIso(br: string): string {
  const [d, m, y] = br.split('/');
  return `${y}-${m}-${d}`;
}

async function complementarCdiComBcb(
  mapa: Map<string, number>,
  dataInicioIso: string,
  dataFimIso: string,
): Promise<void> {
  if (dataInicioIso > dataFimIso) return;

  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados`
    + `?formato=json&dataInicial=${encodeURIComponent(isoToBcbDate(dataInicioIso))}`
    + `&dataFinal=${encodeURIComponent(isoToBcbDate(dataFimIso))}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`[bcb] HTTP ${resp.status} ao buscar CDI`);

  const rows = await resp.json() as BcbCdiRow[];
  if (!rows?.length) return;

  // Ancora no último cdi_acum conhecido (ou base 100 se não houver histórico)
  const datas = [...mapa.keys()].sort();
  const ultimaData = datas[datas.length - 1];
  let acumulado = ultimaData ? (mapa.get(ultimaData) ?? 100) : 100;

  for (const r of rows) {
    const iso = bcbDateToIso(r.data);
    const taxa = Number(String(r.valor).replace(',', '.'));
    if (!Number.isFinite(taxa)) continue;
    acumulado *= (1 + (taxa / 100));
    mapa.set(iso, Number(acumulado.toFixed(8)));
  }
}

async function carregarCdi(): Promise<Map<string, number>> {
  // Coluna de data em historico_mercado é 'data' (não 'data_ref')
  const rows = await query(
    'historico_mercado?select=data,cdi_acum&cdi_acum=not.is.null&order=data.asc'
  ) as CdiRow[];
  const m = new Map<string, number>();
  rows.forEach(r => {
    if (r.cdi_acum != null) m.set(r.data.slice(0, 10), Number(r.cdi_acum));
  });

  // Fallback: se historico_mercado estiver desatualizado, complementa CDI via BCB.
  const datas = [...m.keys()].sort();
  const ultimaDataLocal = datas[datas.length - 1];
  const hoje = new Date().toISOString().slice(0, 10);
  if (!ultimaDataLocal || ultimaDataLocal < hoje) {
    const inicio = ultimaDataLocal ? addDays(ultimaDataLocal, 1) : addDays(hoje, -370);
    try {
      await complementarCdiComBcb(m, inicio, hoje);
    } catch (e) {
      console.warn('[calcular-risco-mercado-fundos] Falha ao complementar CDI via BCB:', e);
    }
  }

  return m;
}

// ── Dados de XML (posicao_carteira) ──────────────────────────
// Colunas reais: fundo_cnpj, fundo_dtposicao (YYYYMMDD string), fundo_valorcota, fundo_patliq, nome_fundo
// Filtro section in (caixa,despesas) — mesmo proxy usado pelo script Python

async function carregarXml(): Promise<Map<string, DiaEntry[]>> {
  const rows = await query(
    `posicao_carteira?select=fundo_cnpj,nome_fundo,fundo_nome,fundo_dtposicao,fundo_patliq,fundo_valorcota`
    + `&section=in.(caixa,despesas)`
    + `&fundo_valorcota=not.is.null`
    + `&fundo_valorcota=gt.0`
    + `&order=fundo_cnpj.asc,fundo_dtposicao.asc`
  ) as XmlRow[];

  // Converte fundo_dtposicao (YYYYMMDD) para ISO 'YYYY-MM-DD'
  function dtToIso(dt: string): string {
    const s = dt.replace(/\D/g, '').slice(0, 8);
    if (s.length === 8) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    return s;
  }

  // Agrupa por CNPJ; em caso de duplicata de data, mantém o mais recente (último no sort)
  const mapa = new Map<string, Map<string, DiaEntry>>();
  for (const r of rows) {
    const cnpj = r.fundo_cnpj;
    const data = dtToIso(r.fundo_dtposicao);
    if (!data || data.length < 10) continue;
    if (!mapa.has(cnpj)) mapa.set(cnpj, new Map());
    mapa.get(cnpj)!.set(data, {
      data,
      cota: Number(r.fundo_valorcota),
      pl:   r.fundo_patliq != null ? Number(r.fundo_patliq) : null,
      fonte: 'xml',
    });
  }

  const resultado = new Map<string, DiaEntry[]>();
  for (const [cnpj, diasMap] of mapa) {
    const dias = [...diasMap.values()].sort((a, b) => a.data.localeCompare(b.data));
    resultado.set(cnpj, dias);
  }
  return resultado;
}

// ── Dados de histórico manual ────────────────────────────────
// rentabilidade_fundos(historico_manual): cnpj, data_ref (DATE), cota — sem coluna pl

async function carregarManual(): Promise<Map<string, DiaEntry[]>> {
  const rows = await query(
    `rentabilidade_fundos?select=cnpj,data_ref,cota&fonte=eq.historico_manual&order=cnpj.asc,data_ref.asc`
  ) as ManualRow[];

  const mapa = new Map<string, DiaEntry[]>();
  for (const r of rows) {
    const cnpj = r.cnpj;
    if (!mapa.has(cnpj)) mapa.set(cnpj, []);
    mapa.get(cnpj)!.push({
      data:  r.data_ref.slice(0, 10),
      cota:  Number(r.cota),
      pl:    null,   // rentabilidade_fundos não armazena PL; será null para pontos históricos
      fonte: 'manual',
    });
  }
  return mapa;
}

// ── Mescla série: manual (antes do XML) + XML ────────────────
// Retorna série ordenada sem sobreposição; XML tem prioridade.

function montarSerieHibrida(
  xmlDias:    DiaEntry[],
  manualDias: DiaEntry[] | undefined,
): { serie: DiaEntry[]; fonteGlobal: 'xml' | 'hibrido_manual_xml' } {
  if (!manualDias || manualDias.length === 0) {
    return { serie: xmlDias, fonteGlobal: 'xml' };
  }

  const primeiraDataXml = xmlDias[0]?.data ?? '9999-99-99';
  const manualAntes = manualDias.filter(d => d.data < primeiraDataXml);

  if (manualAntes.length === 0) {
    return { serie: xmlDias, fonteGlobal: 'xml' };
  }

  const serie = [...manualAntes, ...xmlDias].sort((a, b) => a.data.localeCompare(b.data));
  return { serie, fonteGlobal: 'hibrido_manual_xml' };
}

// ── Cálculo de retornos diários ──────────────────────────────

interface RetDia {
  data:  string;
  cota:  number;
  pl:    number | null;
  ret:   number;   // delta_cota_pct (decimal)
}

function calcularRetornos(serie: DiaEntry[]): RetDia[] {
  const resultado: RetDia[] = [];
  for (let i = 1; i < serie.length; i++) {
    const prev = serie[i - 1];
    const curr = serie[i];
    if (prev.cota === 0) continue;
    const ret = (curr.cota - prev.cota) / prev.cota;
    // Filtra evento corporativo (splits, incorporações)
    if (Math.abs(ret) > FILTRO_RET_MAX) continue;
    resultado.push({ data: curr.data, cota: curr.cota, pl: curr.pl, ret });
  }
  return resultado;
}

// ── Estatísticas sobre janela de retornos ────────────────────

interface Stats {
  sigma:          number;   // decimal
  var95Pct:       number;   // OFICIAL: magnitude positiva (decimal) = Z_95 × sigma, horizonte 1d
  var95Rs:        number;   // magnitude positiva (R$)
  drawdownAtual:  number;   // positivo (%)
  drawdownMax:    number;   // positivo (%)
  nObs:           number;
  pl:             number | null;
}

function calcularStats(rets: RetDia[]): Stats | null {
  if (rets.length < MIN_OBS_SIGMA) return null;

  const janela = rets.slice(-MAX_OBS_SIGMA);
  const valores = janela.map(r => r.ret);
  const n = valores.length;

  // Sigma (desvio-padrão amostral) dos retornos DIÁRIOS — sem média, sem horizonte 21d.
  const media = valores.reduce((s, v) => s + v, 0) / n;
  const variancia = valores.reduce((s, v) => s + (v - media) ** 2, 0) / (n - 1);
  const sigma = Math.sqrt(variancia);

  // VaR Paramétrico 95% — 1 dia útil (OFICIAL): magnitude positiva de perda.
  const var95Pct = Z_95 * sigma;

  // PL do último dia da janela para VaR em R$ (magnitude positiva)
  const ultimoPl = janela[janela.length - 1].pl;
  const var95Rs  = ultimoPl != null ? var95Pct * ultimoPl : 0;

  // Drawdown: calculado sobre cotas dos últimos MAX_OBS_SIGMA+1 dias da série original
  const cotasJanela = janela.map(r => r.cota);
  let pico = cotasJanela[0];
  let ddAtual = 0;
  let ddMax   = 0;
  for (const c of cotasJanela) {
    if (c > pico) pico = c;
    const dd = pico > 0 ? (pico - c) / pico * 100 : 0;
    if (dd > ddMax) ddMax = dd;
    ddAtual = dd;
  }

  return {
    sigma,
    var95Pct,
    var95Rs,
    drawdownAtual: ddAtual,
    drawdownMax:   ddMax,
    nObs:          n,
    pl:            ultimoPl,
  };
}

// ── VaR Histórico 95% (5º percentil dos retornos rolling 21d) ──

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/** Retornos rolling 21d a partir de retornos diários (decimal). */
function calcularRetornos21d(valores: number[]): number[] {
  const ret21d: number[] = [];
  for (let i = HORIZONTE_21D - 1; i < valores.length; i++) {
    let acc = 1;
    for (let j = i - (HORIZONTE_21D - 1); j <= i; j++) {
      acc *= (1 + valores[j]);
    }
    const r21 = acc - 1;
    if (Math.abs(r21) <= FILTRO_RET_MAX) ret21d.push(r21);
  }
  return ret21d;
}

interface VarHistoricoStats {
  var95Pct:  number;   // OFICIAL: magnitude positiva (×100 para exibição). Nunca < 0.
  var95Rs:   number;   // magnitude positiva (R$). Nunca < 0.
  nObs21d:   number;   // nº de JANELAS 21d efetivamente usadas no percentil (não dias!)
}

function calcularVarHistorico(rets: RetDia[]): VarHistoricoStats | null {
  const valores = rets.map(r => r.ret);
  const ret21d = calcularRetornos21d(valores);
  if (ret21d.length < MIN_OBS_HIST) return null;

  const janela = ret21d.slice(-MAX_OBS_SIGMA);
  const sorted = [...janela].sort((a, b) => a - b);
  const p5 = percentile(sorted, 5); // 5º percentil da série de retornos 21d (pode ser > 0)

  // VaR Histórico 95% — 21 dias úteis (OFICIAL): magnitude positiva de perda.
  // Se P5 > 0 (nenhuma perda relevante na cauda de 5%), o VaR é 0 — nunca negativo.
  const var95Decimal = Math.max(0, -p5);

  const ultimoPl = rets[rets.length - 1].pl;
  const var95Rs  = ultimoPl != null ? var95Decimal * ultimoPl : 0;

  return {
    var95Pct: var95Decimal * 100,
    var95Rs,
    nObs21d:  janela.length,
  };
}

function diffDias(isoA: string, isoB: string): number {
  const a = new Date(`${isoA}T12:00:00Z`).getTime();
  const b = new Date(`${isoB}T12:00:00Z`).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function calcularQualidadeSerie(
  serie: DiaEntry[],
  fonteGlobal: 'xml' | 'hibrido_manual_xml',
): QualidadeSerieStats {
  let extremos1d = 0;
  let maiorGapDias = 0;
  const rawRets: number[] = [];

  for (let i = 1; i < serie.length; i++) {
    const prev = serie[i - 1];
    const curr = serie[i];

    const gap = diffDias(prev.data, curr.data);
    if (gap > maiorGapDias) maiorGapDias = gap;

    if (prev.cota === 0) continue;
    const ret = (curr.cota - prev.cota) / prev.cota;
    rawRets.push(ret);
    if (Math.abs(ret) > FILTRO_RET_MAX) extremos1d++;
  }

  let extremos21d = 0;
  if (rawRets.length >= HORIZONTE_21D) {
    for (let i = HORIZONTE_21D - 1; i < rawRets.length; i++) {
      let acc = 1;
      for (let j = i - (HORIZONTE_21D - 1); j <= i; j++) acc *= (1 + rawRets[j]);
      const r21 = acc - 1;
      if (Math.abs(r21) > FILTRO_RET_MAX) extremos21d++;
    }
  }

  return {
    extremos1d,
    extremos21d,
    maiorGapDias,
    quebraDetectada: maiorGapDias > GAP_QUEBRA_DIAS,
    trocaCnpj: fonteGlobal === 'hibrido_manual_xml',
  };
}

function avaliarQualidadeSerie(
  stats: Stats | null,
  varHist: VarHistoricoStats | null,
  q: QualidadeSerieStats,
): { status: 'ok' | 'suspeita' | 'sem_dados'; suspeita: boolean; alertas: string[]; historicoBaixo: boolean } {
  if (!stats && !varHist) {
    return { status: 'sem_dados', suspeita: true, alertas: ['sem_dados'], historicoBaixo: true };
  }

  const alertas: string[] = [];

  if ((stats?.drawdownAtual ?? 0) > DD_SUSPEITO_PCT || (stats?.drawdownMax ?? 0) > DD_SUSPEITO_PCT) {
    alertas.push('dd_gt_50');
  }
  if (q.extremos1d > 0) alertas.push('ret_1d_extremo');
  if (q.extremos21d > 0) alertas.push('ret_21d_extremo');
  if (q.quebraDetectada) alertas.push('quebra_serie');
  if (q.trocaCnpj) alertas.push('troca_cnpj');

  const historicoBaixo = (stats?.nObs ?? 0) < MIN_NOBS_1D_QUALI || (varHist?.nObs21d ?? 0) < MIN_NOBS_21D_QUALI;
  if (historicoBaixo) alertas.push('historico_baixo');

  const suspeita = alertas.length > 0;
  return { status: suspeita ? 'suspeita' : 'ok', suspeita, alertas, historicoBaixo };
}

// ── Processamento por CNPJ ───────────────────────────────────

interface LinhaUpsert {
  cnpj:                string;
  nome_fundo:          string;
  data_ref:            string;
  pl:                  number | null;
  cota:                number;
  delta_cota_pct:      number;
  cdi_valor:           number | null;
  delta_cdi_pct:       number | null;
  relacao_cota_cdi:    number | null;
  status_cota_cdi:     'ok' | 'atencao' | 'sem_dados';
  var_param_dia_pct:   number;
  sigma_diario_pct:    number | null;
  // OFICIAL V3 — magnitude positiva, horizonte explícito no nome do campo.
  var_95_param_1d_pct:   number | null;
  var_95_param_1d_rs:    number | null;
  var_95_hist_21d_pct:   number | null;
  var_95_hist_21d_rs:    number | null;
  // @deprecated — mantidos populados (mesmos valores, mesma convenção positiva) só por
  // compatibilidade com consumidores existentes. Usar os campos _1d_/_21d_ acima.
  var_95_param_pct:    number | null;
  var_95_param_rs:     number | null;
  var_95_hist_pct:     number | null;
  var_95_hist_rs:      number | null;
  n_obs_21d:           number | null;
  drawdown_atual_pct:  number | null;
  drawdown_max_pct:    number | null;
  n_obs:               number | null;
  qualidade_serie_status: 'ok' | 'suspeita' | 'sem_dados';
  serie_suspeita:         boolean;
  serie_alertas:          string[];
  serie_extremos_1d:      number;
  serie_extremos_21d:     number;
  serie_maior_gap_dias:   number;
  serie_hist_baixo:       boolean;
  serie_quebra_detectada: boolean;
  serie_troca_cnpj:       boolean;
  fonte_cota:          'xml' | 'hibrido_manual_xml';
}

interface QualidadeSerieStats {
  extremos1d: number;
  extremos21d: number;
  maiorGapDias: number;
  quebraDetectada: boolean;
  trocaCnpj: boolean;
}

function processarCnpj(
  cnpj:         string,
  nomeFundo:    string,
  xmlDias:      DiaEntry[],
  manualDias:   DiaEntry[] | undefined,
  cdiMap:       Map<string, number>,
): LinhaUpsert[] {
  const { serie, fonteGlobal } = montarSerieHibrida(xmlDias, manualDias);
  const rets = calcularRetornos(serie);
  if (rets.length === 0) return [];
  const qSerie = calcularQualidadeSerie(serie, fonteGlobal);

  // Recorta apenas os últimos JANELA_DIAS_CALCULO dias corridos para upsert
  const dataCorte = new Date();
  dataCorte.setDate(dataCorte.getDate() - JANELA_DIAS_CALCULO);
  const dataCorteStr = dataCorte.toISOString().slice(0, 10);

  const linhas: LinhaUpsert[] = [];

  for (let i = 0; i < rets.length; i++) {
    const dia = rets[i];
    if (dia.data < dataCorteStr) continue;

    // CDI
    const cdiAtual = cdiMap.get(dia.data) ?? null;
    const cdiPrev  = i > 0 ? (cdiMap.get(rets[i - 1].data) ?? null) : null;
    let deltaCdi: number | null = null;
    if (cdiAtual != null && cdiPrev != null && cdiPrev !== 0) {
      deltaCdi = (cdiAtual - cdiPrev) / cdiPrev;
    }

    // Relação cota vs CDI
    let relacao: number | null = null;
    let status: 'ok' | 'atencao' | 'sem_dados' = 'sem_dados';
    if (deltaCdi != null && Math.abs(deltaCdi) > 0) {
      relacao = Math.abs(dia.ret) / Math.abs(deltaCdi);
      status  = relacao > THRESHOLD_RELACAO ? 'atencao' : 'ok';
    }

    // VaR param do dia (série ilustrativa para o gráfico de drill-down) — magnitude positiva.
    const varParamDia = Z_95 * Math.abs(dia.ret) * 100;

    // Stats: σ/VaR Param 1d usam até 252 retornos diários
    const retsAte = rets.slice(Math.max(0, i + 1 - MAX_OBS_SIGMA), i + 1);
    // VaR Hist 21d: precisa de até 272 retornos diários para formar até 252 janelas rolling 21d
    const retsAteHist = rets.slice(Math.max(0, i + 1 - MAX_DIAS_VAR_HIST), i + 1);
    const stats   = calcularStats(retsAte);
    const varHist = calcularVarHistorico(retsAteHist);
    const qualidade = avaliarQualidadeSerie(stats, varHist, qSerie);

    const varParam1dPct = stats ? stats.var95Pct * 100 : null;
    const varParam1dRs  = stats ? stats.var95Rs : null;
    const varHist21dPct = varHist ? varHist.var95Pct : null;
    const varHist21dRs  = varHist ? varHist.var95Rs : null;

    linhas.push({
      cnpj,
      nome_fundo:         nomeFundo,
      data_ref:           dia.data,
      pl:                 dia.pl,
      cota:               dia.cota,
      delta_cota_pct:     dia.ret,
      cdi_valor:          cdiAtual,
      delta_cdi_pct:      deltaCdi,
      relacao_cota_cdi:   relacao,
      status_cota_cdi:    status,
      var_param_dia_pct:  varParamDia,
      sigma_diario_pct:   stats ? stats.sigma * 100 : null,
      var_95_param_1d_pct: varParam1dPct,
      var_95_param_1d_rs:  varParam1dRs,
      var_95_hist_21d_pct: varHist21dPct,
      var_95_hist_21d_rs:  varHist21dRs,
      // Legado (@deprecated) — mesmos valores, mesma convenção positiva
      var_95_param_pct:   varParam1dPct,
      var_95_param_rs:    varParam1dRs,
      var_95_hist_pct:    varHist21dPct,
      var_95_hist_rs:     varHist21dRs,
      n_obs_21d:          varHist ? varHist.nObs21d : null,
      drawdown_atual_pct: stats ? stats.drawdownAtual : null,
      drawdown_max_pct:   stats ? stats.drawdownMax : null,
      n_obs:              stats ? stats.nObs : null,
      qualidade_serie_status: qualidade.status,
      serie_suspeita:         qualidade.suspeita,
      serie_alertas:          qualidade.alertas,
      serie_extremos_1d:      qSerie.extremos1d,
      serie_extremos_21d:     qSerie.extremos21d,
      serie_maior_gap_dias:   qSerie.maiorGapDias,
      serie_hist_baixo:       qualidade.historicoBaixo,
      serie_quebra_detectada: qSerie.quebraDetectada,
      serie_troca_cnpj:       qSerie.trocaCnpj,
      fonte_cota:         fonteGlobal,
    });
  }

  return linhas;
}

// ── Inserção de log ──────────────────────────────────────────

async function criarLog(origem: string): Promise<string> {
  const url = `${SUPABASE_URL}/rest/v1/risco_mercado_fundos_calc_log`;
  const h   = { ...headers(), 'Prefer': 'return=representation' };
  const res = await fetch(url, {
    method:  'POST',
    headers: h,
    body:    JSON.stringify({ origem, status: 'running', iniciado_em: new Date().toISOString() }),
  });
  const data = await res.json();
  return data[0]?.id ?? 'unknown';
}

// ── Leitura de nome_fundo via XML ────────────────────────────

async function carregarNomesXml(): Promise<Map<string, string>> {
  const rows = await query(
    `posicao_carteira?select=fundo_cnpj,nome_fundo,fundo_nome&section=in.(caixa,despesas)&fundo_valorcota=not.is.null&fundo_valorcota=gt.0`
  ) as { fundo_cnpj: string; nome_fundo: string | null; fundo_nome: string | null }[];
  const m = new Map<string, string>();
  for (const r of rows) {
    if (!m.has(r.fundo_cnpj)) {
      const nome = r.nome_fundo ?? r.fundo_nome;
      if (nome) m.set(r.fundo_cnpj, nome);
    }
  }
  return m;
}

// ── Handler principal ────────────────────────────────────────

async function handleRun(origem: string): Promise<Response> {
  const logId = await criarLog(origem);

  try {
    // Carrega dados em paralelo
    const [cdiMap, xmlMap, manualMap, nomesXml] = await Promise.all([
      carregarCdi(),
      carregarXml(),
      carregarManual(),
      carregarNomesXml(),
    ]);

    const cnpjs = [...xmlMap.keys()];
    let processados = 0;
    let comErro     = 0;

    for (const cnpj of cnpjs) {
      try {
        const xmlDias    = xmlMap.get(cnpj) ?? [];
        const manualDias = manualMap.get(cnpj);
        const nome       = nomesXml.get(cnpj) ?? cnpj;

        if (xmlDias.length === 0) continue;

        const linhas = processarCnpj(cnpj, nome, xmlDias, manualDias, cdiMap);
        if (linhas.length > 0) {
          await upsertBatch('risco_mercado_fundos_diario', linhas as Record<string, unknown>[], 'cnpj,data_ref');
        }
        processados++;
      } catch (err) {
        console.error(`[calcular-risco-mercado-fundos] Erro no CNPJ ${cnpj}:`, err);
        comErro++;
      }
    }

    await updateLog(logId, {
      status:             'success',
      fundos_processados: processados,
      fundos_com_erro:    comErro,
      mensagem:           `${processados} fundos processados, ${comErro} com erro.`,
      concluido_em:       new Date().toISOString(),
    });

    return jsonResponse({
      ok:                 true,
      fundos_processados: processados,
      fundos_com_erro:    comErro,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateLog(logId, {
      status:         'error',
      erro_mensagem:  msg,
      concluido_em:   new Date().toISOString(),
    });
    return jsonResponse({ ok: false, error: msg }, 500);
  }
}

async function handleSetupCron(): Promise<Response> {
  const funcUrl = `${SUPABASE_URL}/functions/v1/calcular-risco-mercado-fundos`;
  try {
    const resultado = await rpc('setup_risco_mercado_fundos_cron', {
      p_function_url: funcUrl,
      p_service_role: SERVICE_ROLE_KEY,
    });
    return jsonResponse({ ok: true, resultado });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
}

// ── Entry point ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  let body: { action?: string; origem?: string } = {};
  try {
    body = req.method === 'POST' ? await req.json() : {};
  } catch {
    // body vazio é ok
  }

  const action = body.action ?? 'run';
  const origem = body.origem ?? 'manual';

  if (action === 'setup_cron') {
    return handleSetupCron();
  }

  return handleRun(origem);
});
