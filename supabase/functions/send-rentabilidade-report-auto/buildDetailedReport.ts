/** Gera HTML e Excel somente a partir dos snapshots persistidos V2. */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import type { FundoXmlCoverageRow, RentabilidadeFundoRow } from "./calc.ts";
import { generateRentabilidadeEmailHTML } from "./emailHtml.ts";
import { collectCnpjsAtivos } from "./prepareRelatorioData.ts";
import { prepareFundosRelatorio, type AtivoRelatorio, type SummaryData } from "./relatorioHTML_v2.ts";
import { buildRentabilidadeRelatorioExcelBuffer } from "./relatorioExcel.ts";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchSiglasNomesFundos(
  supabase: SupabaseClient,
  cnpjs: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(cnpjs.map((cnpj) => cnpj.replace(/\D/g, "")).filter(Boolean))];
  if (unique.length === 0) return {};
  const { data, error } = await supabase.from("nomes_fundos").select("cnpj, sigla").in("cnpj", unique);
  if (error || !data?.length) return {};
  return Object.fromEntries(
    data
      .map((row: { cnpj: string; sigla: string | null }) => [row.cnpj?.replace(/\D/g, ""), row.sigla?.trim()])
      .filter(([cnpj, sigla]) => Boolean(cnpj && sigla)),
  );
}

export interface BuildDetailedReportParams {
  supabase: SupabaseClient;
  fundos: RentabilidadeFundoRow[];
  dataReferencia: string;
  ativosMap: Map<string, AtivoRelatorio[]>;
  faltantes: FundoXmlCoverageRow[];
}

export interface BuildDetailedReportResult {
  html: string;
  excelBase64: string;
  excelFilename: string;
  summary: SummaryData;
}

export async function buildDetailedReport(
  { supabase, fundos, dataReferencia, ativosMap, faltantes }: BuildDetailedReportParams,
): Promise<BuildDetailedReportResult> {
  console.log(`[buildDetailedReport] Montando relatorio de ${fundos.length} snapshots V2`);
  const { fundos: fundosRelatorio, summary } = prepareFundosRelatorio(fundos, ativosMap);
  const siglasPorCnpj = await fetchSiglasNomesFundos(supabase, [
    ...collectCnpjsAtivos(ativosMap),
    ...faltantes.map((fundo) => fundo.cnpj_fundo),
  ]);
  const html = generateRentabilidadeEmailHTML(
    fundosRelatorio,
    summary,
    dataReferencia,
    siglasPorCnpj,
    { cdiDiaPct: fundos[0]?.cdi_dia_pct ?? null, faltantes },
  );
  const { buffer, filename } = await buildRentabilidadeRelatorioExcelBuffer(fundosRelatorio, dataReferencia);
  const excelBase64 = arrayBufferToBase64(buffer);
  console.log(`[buildDetailedReport] HTML e Excel dos snapshots prontos (${(excelBase64.length / 1024).toFixed(0)} KB)`);
  return { html, excelBase64, excelFilename: filename, summary };
}
