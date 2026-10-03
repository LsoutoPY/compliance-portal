import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { crypto } from 'https://deno.land/std@0.168.0/crypto/mod.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

interface AtivoData {
  tipo_ativo: string;
  descricao: string | null;
  isin: string | null;
  cnpj: string | null;
  ticker: string | null;
  codigo_cetip_selic: string | null;
  matricula_imovel: string | null;
  endereco_imovel: string | null;
}

async function md5Hash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('MD5', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function extractAtivoData(record: Record<string, unknown>): AtivoData {
  const section = record['section'] as string;
  const ativo: AtivoData = {
    tipo_ativo: section?.toUpperCase() || 'OUTROS',
    descricao: null,
    isin: record['isin'] as string | null,
    cnpj: null,
    ticker: record['codativo'] as string | null,
    codigo_cetip_selic: null,
    matricula_imovel: record['matricula'] as string | null,
    endereco_imovel: null
  };

  if (section === 'cotas') {
    ativo.tipo_ativo = 'FUNDO';
    ativo.cnpj = record['cnpjfundo'] as string | null;
    ativo.descricao = null;
  } else if (section === 'acoes') {
    ativo.tipo_ativo = 'ACAO';
    ativo.descricao = (record['codativo'] as string) || (record['isin'] as string) || 'ACAO SEM NOME';
  } else if (section === 'titpublico') {
    ativo.tipo_ativo = 'TITULO_PUBLICO';
    ativo.codigo_cetip_selic = record['codativo'] as string | null;
    ativo.descricao = (record['codativo'] as string) || 'TITULO PUBLICO';
  } else if (section === 'titprivado') {
    ativo.tipo_ativo = 'TITULO_PRIVADO';
    ativo.cnpj = record['cnpjemissor'] as string | null;
    ativo.codigo_cetip_selic = record['codativo'] as string | null;
    ativo.descricao = `${record['codativo'] || ''} - ${record['cnpjemissor'] || ''}`;
  } else if (section === 'imoveis') {
    ativo.tipo_ativo = 'IMOVEL';
    ativo.cnpj = record['cnpjemp'] as string | null;
    ativo.descricao = (record['nomecomercial'] as string) || 'IMOVEL';
    const parts = ['logradouro', 'numero', 'cidade', 'estado']
      .map(k => record[k])
      .filter(Boolean);
    if (parts.length > 0) {
      ativo.endereco_imovel = parts.join(', ');
    }
  } else if (section === 'participacoes') {
    ativo.tipo_ativo = 'PARTICIPACAO';
    ativo.cnpj = record['cnpjpart'] as string | null;
    if (!ativo.cnpj) ativo.cnpj = record['cnpjemissor'] as string | null;
    ativo.descricao = ativo.cnpj ? `PARTICIPACAO CNPJ ${ativo.cnpj}` : null;
  } else if (section === 'caixa') {
    ativo.tipo_ativo = 'CAIXA';
    ativo.isin = record['isininstituicao'] as string | null;
    ativo.descricao = `CAIXA - ${record['isininstituicao'] || ''}`;
  } else if (section === 'fidc') {
    ativo.tipo_ativo = 'FIDC';
    ativo.cnpj = record['cnpjemissor'] as string | null;
    ativo.descricao = (record['nomecomercial'] as string) || (ativo.cnpj ? `FIDC - ${ativo.cnpj}` : null);
  }

  return ativo;
}

function isIsinValid(isin: string | null): boolean {
  if (!isin) return false;
  if (isin.includes('*')) return false; // Mascarado
  // Validação básica de formato se necessário, mas asterisco é o principal problema relatado
  return true;
}

async function getAtivoIdentifier(ativo: AtivoData): Promise<string> {
  const tipo = ativo.tipo_ativo;

  if (tipo === 'IMOVEL') {
    if (ativo.matricula_imovel) return `MAT:${ativo.matricula_imovel}`;
    if (ativo.endereco_imovel) return `END:${await md5Hash(ativo.endereco_imovel)}`;
    return `DESC:${await md5Hash(ativo.descricao || '')}`;
  }

  // Para FUNDOS, prioriza ISIN pois cada classe/série tem ISIN único
  if (tipo === 'FUNDO' && isIsinValid(ativo.isin)) {
    return `ISIN:${ativo.isin}`;
  }

  // Para outros tipos ou fundos sem ISIN válido, prioriza CNPJ
  if (ativo.cnpj) return `CNPJ:${ativo.cnpj}`;

  // Só usa ISIN se for válido (não mascarado)
  if (isIsinValid(ativo.isin)) return `ISIN:${ativo.isin}`;
  
  if (ativo.ticker) return `TICKER:${ativo.ticker}`;
  if (ativo.codigo_cetip_selic) return `COD:${ativo.codigo_cetip_selic}`;
  
  // Fallbacks
  if (ativo.matricula_imovel) return `MAT:${ativoa.matricula_imovel}`;
  if (ativo.endereco_imovel) return `END:${await md5Hash(ativo.endereco_imovel)}`;
  return `DESC:${await md5Hash(ativo.descricao || '')}`;
}

async function getFundNameFromRegistry(cnpj: string, isin: string | null = null): Promise<string | null> {
  const cnpjClean = cnpj.replace(/\D/g, '');
  const cnpjNum = parseInt(cnpjClean);
  
  try {
    // PRIORIDADE 1: Se tem ISIN, busca por CNPJ + ISIN em fundos_caracteristicas
    if (isin && isin.length === 12) {
      const { data: fcIsin } = await supabase
        .from('fundos_caracteristicas')
        .select('nome_comercial')
        .eq('isin', isin)
        .or(`cnpj_classe.eq.${cnpjClean},cnpj_fundo.eq.${cnpjClean}`)
        .limit(1)
        .maybeSingle();
      if (fcIsin?.nome_comercial) return fcIsin.nome_comercial;
    }

    // PRIORIDADE 2: Busca em fundos_caracteristicas só por CNPJ
    const { data: fc } = await supabase
      .from('fundos_caracteristicas')
      .select('nome_comercial')
      .or(`cnpj_classe.eq.${cnpjClean},cnpj_fundo.eq.${cnpjClean}`)
      .or('estrutura.is.null,estrutura.eq.Classe,estrutura.eq.Fundo')
      .limit(1)
      .maybeSingle();
    if (fc?.nome_comercial) return fc.nome_comercial;

  } catch {
    // ignore
  }
  return null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const SECTIONS_COM_ATIVO = ['cotas', 'titpublico', 'titprivado', 'caixa', 'participacoes', 'acoes', 'imoveis', 'fidc'];
    const { data: records, error: fetchError } = await supabase
      .from('posicao_carteira')
      .select('id, natural_key, section, isin, codativo, cnpjfundo, cnpjemissor, cnpjpart, nomecomercial, matricula, cnpjemp, isininstituicao, logradouro, numero, cidade, estado, ativo_id')
      .in('section', SECTIONS_COM_ATIVO);

    if (fetchError) {
      console.error('Erro ao buscar posicao_carteira:', fetchError);
      return new Response(
        JSON.stringify({ success: false, error: fetchError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const recordsList = records || [];
    const identifierToAtivoId = new Map<string, string>();
    const identifierToRecordIds = new Map<string, string[]>();
    const identifierToData = new Map<string, AtivoData>();

    for (const rec of recordsList) {
      const section = rec.section;
      if (!section) continue;

      const ativoData = extractAtivoData(rec as Record<string, unknown>);
      const identifier = await getAtivoIdentifier(ativoData);

      if (!identifierToRecordIds.has(identifier)) {
        identifierToRecordIds.set(identifier, []);
        identifierToData.set(identifier, ativoData);
      }
      identifierToRecordIds.get(identifier)!.push(rec.id);
    }

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const [identifier, data] of identifierToData) {
      let ativoId: string | null = null;

      if (data.tipo_ativo === 'IMOVEL' && data.matricula_imovel) {
        const { data: existing } = await supabase
          .from('ativos')
          .select('id')
          .eq('matricula_imovel', data.matricula_imovel)
          .limit(1)
          .maybeSingle();
        ativoId = existing?.id || null;
      } else if (data.isin) {
        const { data: existing } = await supabase
          .from('ativos')
          .select('id')
          .eq('isin', data.isin)
          .limit(1)
          .maybeSingle();
        ativoId = existing?.id || null;
      } else if (data.cnpj) {
        const { data: existing } = await supabase
          .from('ativos')
          .select('id')
          .eq('cnpj', data.cnpj)
          .limit(1)
          .maybeSingle();
        ativoId = existing?.id || null;
      } else if (data.ticker) {
        const { data: existing } = await supabase
          .from('ativos')
          .select('id')
          .eq('ticker', data.ticker)
          .limit(1)
          .maybeSingle();
        ativoId = existing?.id || null;
      } else if (data.codigo_cetip_selic) {
        const { data: existing } = await supabase
          .from('ativos')
          .select('id')
          .eq('codigo_cetip_selic', data.codigo_cetip_selic)
          .limit(1)
          .maybeSingle();
        ativoId = existing?.id || null;
      }

      if (ativoId) {
        // Se for fundo e a descrição for genérica ou nula, tenta melhorar
        if (data.tipo_ativo === 'FUNDO' && data.cnpj) {
          const { data: current } = await supabase
            .from('ativos')
            .select('descricao')
            .eq('id', ativoId)
            .single();
            
          const currentDesc = current?.descricao;
          if (!currentDesc || currentDesc.startsWith('FUNDO CNPJ')) {
            const realName = await getFundNameFromRegistry(data.cnpj, data.isin);
            if (realName && realName !== currentDesc) {
              await supabase.from('ativos').update({ descricao: realName }).eq('id', ativoId);
            }
          }
        }
      }

      if (!ativoId) {
        if (data.tipo_ativo === 'FUNDO' && data.cnpj && !data.descricao) {
          const realName = await getFundNameFromRegistry(data.cnpj, data.isin);
          data.descricao = realName || `FUNDO CNPJ ${data.cnpj}`;
        }
        if (data.tipo_ativo === 'FIDC' && data.cnpj && !data.descricao) {
          const realName = await getFundNameFromRegistry(data.cnpj, data.isin);
          data.descricao = realName || `FIDC - ${data.cnpj}`;
        }

        const payload: Record<string, unknown> = {
          ...data,
          validado: false
        };
        const cleanPayload: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload)) {
          if (v !== null) cleanPayload[k] = v;
        }

        const { data: createdRow, error: insertError } = await supabase
          .from('ativos')
          .insert(cleanPayload)
          .select('id')
          .single();

        if (insertError) {
          errors.push(`Falha ao criar ativo ${data.tipo_ativo} (${identifier}): ${insertError.message}`);
          continue;
        }
        ativoId = createdRow?.id as string;
        created++;
      }

      const recordIds = identifierToRecordIds.get(identifier) || [];
      if (recordIds.length > 0) {
        const { data: updData, error: updError } = await supabase
          .from('posicao_carteira')
          .update({ ativo_id: ativoId })
          .in('id', recordIds)
          .select('id');

        if (!updError && updData) updated += updData.length;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        ativosCriados: created,
        registrosAtualizados: updated,
        totalIdentificadores: identifierToData.size,
        errors: errors.length > 0 ? errors : undefined
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Erro sync-ativos-carteira:', err);
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
