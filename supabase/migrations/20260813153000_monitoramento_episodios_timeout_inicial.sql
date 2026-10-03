-- A primeira sincronização de episódios percorre o histórico diário para
-- encontrar o início real de cada sequência. O timeout padrão da API é curto
-- para essa carga inicial; nas próximas execuções os episódios já existentes
-- são atualizados pelo mesmo identificador.

CREATE INDEX IF NOT EXISTS idx_enquadramento_resultado_episodios_serie
  ON public.enquadramento_resultado (fundo_cnpj, fundo_isin, regra_codigo, fundo_dtposicao)
  INCLUDE (status, regra_categoria, regra_descricao, valor_atual, valor_limite);

CREATE INDEX IF NOT EXISTS idx_liquidez_monitoramento_episodios_serie
  ON public.liquidez_monitoramento_risco (fundo_cnpj, is_fundo_fechado, dt_posicao)
  INCLUDE (status, indice_liquidez, meses_cobertura);

CREATE INDEX IF NOT EXISTS idx_risco_mercado_episodios_serie
  ON public.risco_mercado_fundos_diario (cnpj, data_ref)
  INCLUDE (status_cota_cdi, relacao_cota_cdi, nome_fundo);

-- O parâmetro fica limitado a esta função; não altera o timeout das demais
-- operações do sistema. Evita cancelamento da carga histórica pelo PostgREST.
ALTER FUNCTION public.sincronizar_episodios_risco() SET statement_timeout = '60s';

COMMENT ON FUNCTION public.sincronizar_episodios_risco() IS
  'Reconstrói episódios a partir das fontes diárias. Na primeira execução pode usar até 60 segundos para ler o histórico.';
