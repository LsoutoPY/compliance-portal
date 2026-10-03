ALTER TABLE public.ativos
ADD COLUMN nome_frontend text;

UPDATE public.ativos
SET nome_frontend = descricao
WHERE nome_frontend IS NULL;

CREATE OR REPLACE FUNCTION public.set_ativos_nome_frontend_default()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.nome_frontend IS NULL THEN
    NEW.nome_frontend := NEW.descricao;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_ativos_nome_frontend_default ON public.ativos;

CREATE TRIGGER trg_set_ativos_nome_frontend_default
BEFORE INSERT OR UPDATE ON public.ativos
FOR EACH ROW
EXECUTE FUNCTION public.set_ativos_nome_frontend_default();

COMMENT ON COLUMN public.ativos.nome_frontend IS
'Nome exibido no frontend. Pode ser ajustado manualmente sem alterar a descricao usada no fluxo de importacao.';
