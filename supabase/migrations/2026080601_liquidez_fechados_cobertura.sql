-- Trilha de liquidez para fundos fechados: despesa operacional via provisões XML (ANBIMA)
-- e persistência de meses de cobertura separada do índice ANBIMA (abertos).

-- ── Provisões operacionais (detalhe) ───────────────────────────────────────
-- Mesma regra de snapshot/ciclo de vw_provisoes_taxas_detalhe, expandindo codprov
-- via catálogo anbima_cod_lancamento (taxas + despesas administrativas).

CREATE OR REPLACE VIEW public.vw_provisoes_despesa_operacional_detalhe AS
WITH codigos_operacionais AS (
  SELECT cod_lancamento
  FROM public.anbima_cod_lancamento
  WHERE grupo IN (
    'Taxas do Fundo',
    'Taxas Regulatórias',
    'Despesas Administrativas'
  )
    AND aceita_debito = true
),
ultima_pos AS (
  SELECT
    p.fundo_cnpj,
    to_char(to_date(p.fundo_dtposicao, 'YYYYMMDD'), 'YYYY-MM') AS mes_ref,
    max(p.fundo_dtposicao) AS fundo_dtposicao
  FROM public.posicao_carteira p
  INNER JOIN codigos_operacionais c ON c.cod_lancamento = p.codprov
  WHERE p.section = 'provisao'
    AND p.credeb = 'D'
  GROUP BY p.fundo_cnpj, to_char(to_date(p.fundo_dtposicao, 'YYYYMMDD'), 'YYYY-MM')
),
max_dt_por_codprov AS (
  SELECT
    p.fundo_cnpj,
    p.fundo_dtposicao,
    p.codprov,
    max(p.dt) AS dt_vigente
  FROM public.posicao_carteira p
  INNER JOIN ultima_pos u
    ON u.fundo_cnpj = p.fundo_cnpj
   AND u.fundo_dtposicao = p.fundo_dtposicao
  INNER JOIN codigos_operacionais c ON c.cod_lancamento = p.codprov
  WHERE p.section = 'provisao'
    AND p.credeb = 'D'
  GROUP BY p.fundo_cnpj, p.fundo_dtposicao, p.codprov
),
linhas_vigentes AS (
  SELECT
    p.fundo_cnpj,
    u.mes_ref,
    p.fundo_dtposicao,
    p.codprov,
    a.descricao,
    a.grupo,
    p.dt AS dt_provisao,
    p.valor
  FROM public.posicao_carteira p
  INNER JOIN ultima_pos u
    ON u.fundo_cnpj = p.fundo_cnpj
   AND u.fundo_dtposicao = p.fundo_dtposicao
  INNER JOIN max_dt_por_codprov m
    ON m.fundo_cnpj = p.fundo_cnpj
   AND m.fundo_dtposicao = p.fundo_dtposicao
   AND m.codprov = p.codprov
   AND p.dt = m.dt_vigente
  INNER JOIN codigos_operacionais c ON c.cod_lancamento = p.codprov
  LEFT JOIN public.anbima_cod_lancamento a ON a.cod_lancamento = p.codprov
  WHERE p.section = 'provisao'
    AND p.credeb = 'D'
)
SELECT
  fundo_cnpj,
  mes_ref,
  fundo_dtposicao AS data_snapshot,
  codprov,
  descricao,
  grupo,
  dt_provisao,
  round(valor, 2) AS valor
FROM linhas_vigentes;

COMMENT ON VIEW public.vw_provisoes_despesa_operacional_detalhe IS
  'Provisões de despesa operacional (codprov ANBIMA) no último snapshot do mês, ciclo vigente por codprov.';

GRANT SELECT ON public.vw_provisoes_despesa_operacional_detalhe TO anon, authenticated, service_role;

-- ── Agregado mensal ─────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.vw_provisoes_despesa_operacional_mes AS
SELECT
  fundo_cnpj,
  mes_ref,
  data_snapshot,
  round(coalesce(sum(valor), 0), 2) AS despesa_operacional_mensal,
  round(coalesce(sum(valor) FILTER (WHERE grupo = 'Taxas do Fundo'), 0), 2) AS taxas_fundo,
  round(coalesce(sum(valor) FILTER (WHERE grupo = 'Taxas Regulatórias'), 0), 2) AS taxas_regulatorias,
  round(coalesce(sum(valor) FILTER (WHERE grupo = 'Despesas Administrativas'), 0), 2) AS despesas_administrativas,
  count(*)::integer AS qtd_linhas
FROM public.vw_provisoes_despesa_operacional_detalhe
GROUP BY fundo_cnpj, mes_ref, data_snapshot;

COMMENT ON VIEW public.vw_provisoes_despesa_operacional_mes IS
  'Despesa operacional mensal estimada via provisões XML (ANBIMA) para fundos fechados.';

GRANT SELECT ON public.vw_provisoes_despesa_operacional_mes TO anon, authenticated, service_role;

-- ── Colunas extras em liquidez_monitoramento_risco (trilha fechados) ────────

ALTER TABLE public.liquidez_monitoramento_risco
  ADD COLUMN IF NOT EXISTS meses_cobertura numeric NULL,
  ADD COLUMN IF NOT EXISTS status_cobertura text NULL,
  ADD COLUMN IF NOT EXISTS disp_pl numeric NULL,
  ADD COLUMN IF NOT EXISTS fonte_despesa text NULL;

COMMENT ON COLUMN public.liquidez_monitoramento_risco.meses_cobertura IS
  'Fundos fechados: caixa líquido / despesa operacional mensal.';
COMMENT ON COLUMN public.liquidez_monitoramento_risco.status_cobertura IS
  'Fundos fechados: ok | alerta | violacao | indisponivel (cobertura operacional).';
COMMENT ON COLUMN public.liquidez_monitoramento_risco.disp_pl IS
  'Fundos fechados: disponibilidade/PL informativo (amortização).';
COMMENT ON COLUMN public.liquidez_monitoramento_risco.fonte_despesa IS
  'Origem da despesa operacional: provisoes_xml | despesas_fundo | conferencia_taxas | media_historica | manual.';
