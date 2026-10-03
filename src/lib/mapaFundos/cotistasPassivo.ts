import { supabase } from '@/integrations/supabase/client';
import { cnpjEstrutura, dataIsoEstrutura } from '@/lib/mapaFundos/estrutura';
import {
  aggregatePassivoCotistas,
  resolvePassivoRowsForMapa,
  type PassivoFundoRow,
} from '@/lib/passivoFundoMatch';

const PASSIVO_SELECT = 'fundo, fundo_cnpj, fundo_isin, cotista, valor, codigo_clt, administradora, data_posicao';

export interface ResumoCotistasPassivo {
  cotistas: number;
  dataPosicao: string | null;
}

function asOfYyyymmdd(dataRef: string): string {
  return dataIsoEstrutura(dataRef).replace(/-/g, '');
}

function resumirLinhasPassivo(rows: PassivoFundoRow[]): ResumoCotistasPassivo | null {
  if (!rows.length) return null;
  const dataPosicao = rows.reduce((max, r) => {
    const d = String(r.data_posicao ?? '').replace(/\D/g, '').slice(0, 8);
    return d > max ? d : max;
  }, '');
  return {
    cotistas: aggregatePassivoCotistas(rows).length,
    dataPosicao: dataPosicao || null,
  };
}

export function resumirCotistasPassivoFundos(
  rows: PassivoFundoRow[],
  fundos: { cnpj: string; nome: string }[],
  dataRef: string,
): Map<string, ResumoCotistasPassivo> {
  const asOf = asOfYyyymmdd(dataRef);
  const out = new Map<string, ResumoCotistasPassivo>();
  for (const fundo of fundos) {
    const cnpj = cnpjEstrutura(fundo.cnpj);
    if (cnpj.length !== 14) continue;
    const resolved = resolvePassivoRowsForMapa(rows, {
      cnpj,
      fundName: fundo.nome,
      asOfDate: asOf,
    });
    const resumo = resumirLinhasPassivo(resolved);
    if (resumo) out.set(cnpj, resumo);
  }
  return out;
}

export async function buscarLinhasPassivoFundos(cnpjs: string[]): Promise<PassivoFundoRow[]> {
  if (!cnpjs.length) return [];
  const rows: PassivoFundoRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < cnpjs.length; i += 40) {
    const lote = cnpjs.slice(i, i + 40);
    const ids = [...new Set(lote.flatMap(c => {
      const d = cnpjEstrutura(c);
      if (d.length !== 14) return [];
      return [d, d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')];
    }))];
    if (!ids.length) continue;
    const { data, error } = await supabase.from('passivo_fundos' as never)
      .select(PASSIVO_SELECT)
      .in('fundo_cnpj', ids)
      .order('data_posicao', { ascending: false })
      .limit(50000);
    if (error) {
      if (error.code === '42P01' || (error as { status?: number }).status === 404) return rows;
      throw new Error(`Passivo de fundos indisponível: ${error.message}`);
    }
    for (const row of (data as unknown as PassivoFundoRow[] ?? [])) {
      const k = [row.administradora, row.data_posicao, row.fundo, row.fundo_cnpj, row.cotista, row.valor].join('\0');
      if (!seen.has(k)) {
        seen.add(k);
        rows.push(row);
      }
    }
  }
  return rows;
}

export async function buscarResumoCotistasPassivo(
  fundos: { cnpj: string; nome: string }[],
  dataRef: string,
): Promise<Map<string, ResumoCotistasPassivo>> {
  const cnpjs = [...new Set(fundos.map(f => cnpjEstrutura(f.cnpj)).filter(c => c.length === 14))];
  const rows = await buscarLinhasPassivoFundos(cnpjs);
  return resumirCotistasPassivoFundos(rows, fundos, dataRef);
}

export function aplicarCotistasPassivo(
  itens: Map<string, import('@/lib/mapaFundos/estrutura').ItemEstrutura>,
  passivo: Map<string, ResumoCotistasPassivo>,
): void {
  for (const item of itens.values()) {
    if (item.no.tipo !== 'fundo') continue;
    const resumo = passivo.get(cnpjEstrutura(item.no.cnpj));
    if (!resumo) continue;
    item.cotistasPassivo = resumo.cotistas;
    item.dataPassivo = resumo.dataPosicao;
  }
}
