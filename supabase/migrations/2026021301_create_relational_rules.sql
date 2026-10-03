-- Create table for compliance rules catalog
CREATE TABLE IF NOT EXISTS public.regras_compliance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo TEXT NOT NULL UNIQUE,
    descricao TEXT NOT NULL,
    parametros JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create table for associating rules with funds
CREATE TABLE IF NOT EXISTS public.fundo_regras (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fundo_cnpj TEXT NOT NULL,
    regra_id UUID NOT NULL REFERENCES public.regras_compliance(id),
    ativo BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(fundo_cnpj, regra_id)
);

-- Insert the specific rule requested
INSERT INTO public.regras_compliance (codigo, descricao, parametros)
VALUES (
    'LIMITE_PROFISSIONAL_10', 
    'Fundo pode ter no máximo 10% do PL em fundos do tipo Profissional', 
    '{"limite": 0.10, "tipo_investidor": "Profissional"}'::jsonb
) ON CONFLICT (codigo) DO NOTHING;
