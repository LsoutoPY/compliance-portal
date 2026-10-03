-- RLS para tabelas do módulo tributário (leitura no frontend via anon/authenticated)

ALTER TABLE public.enquadramento_tributario_historico ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fundo_classificacao_tributaria ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on enquadramento_tributario_historico"
  ON public.enquadramento_tributario_historico;
CREATE POLICY "Allow all on enquadramento_tributario_historico"
  ON public.enquadramento_tributario_historico
  FOR ALL
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all on fundo_classificacao_tributaria"
  ON public.fundo_classificacao_tributaria;
CREATE POLICY "Allow all on fundo_classificacao_tributaria"
  ON public.fundo_classificacao_tributaria
  FOR ALL
  USING (true)
  WITH CHECK (true);
