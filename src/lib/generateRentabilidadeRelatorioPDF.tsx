/* eslint-disable react-refresh/only-export-components */

/**
 * PDF do relatório diário de rentabilidade.
 *
 * Usa a mesma fonte de dados, agrupamento, métricas e alertas do e-mail. Assim,
 * PDF, pré-visualização e mensagem enviada contam exatamente a mesma história.
 */

import { Document, Page, Text, View, StyleSheet, pdf } from "@react-pdf/renderer";
import type { AtivoRelatorio, FundoRelatorio, SummaryData } from "@/lib/generateRentabilidadeRelatorioHTML_v2";
import { abreviarAdministrador } from "@/lib/generateRentabilidadeRelatorioHTML_v2";
import type { FundoXmlCoverageRow } from "@/hooks/useRentabilidadeCalc";
import { isFundoExclusivoRentabilidade } from "@/lib/fundosExclusivosRentabilidade";

const PAGE_GREEN = "#1F4E3D";
const SECTION_GREEN = "#3A6B57";
const POSITIVE = "#1B6B3A";
const NEGATIVE = "#9C0006";
const MUTED = "#666666";
const COLUMN_WIDTHS = ["28%", "6.5%", "6.5%", "7%", "5.5%", "7.5%", "5.5%", "7.5%", "5.5%", "7.5%", "5.5%", "7.5%"] as const;

const s = StyleSheet.create({
  page: { fontFamily: "Helvetica", fontSize: 7, paddingTop: 52, paddingHorizontal: 22, paddingBottom: 28, color: "#1a1a1a" },
  fixedHeader: { position: "absolute", top: 16, left: 22, right: 22, backgroundColor: PAGE_GREEN, paddingVertical: 8, paddingHorizontal: 10, flexDirection: "row", justifyContent: "space-between" },
  fixedTitle: { fontSize: 11, fontFamily: "Helvetica-Bold", color: "#FFFFFF" },
  fixedDate: { fontSize: 9, fontFamily: "Helvetica-Bold", color: "#FFFFFF", textAlign: "right" },
  warning: { borderWidth: 0.5, borderColor: "#F4C542", backgroundColor: "#FFFBEB", padding: 8, marginBottom: 6 },
  warningTitle: { fontSize: 7, fontFamily: "Helvetica-Bold", color: "#92400E", marginBottom: 3 },
  warningText: { fontSize: 7, color: "#92400E", lineHeight: 1.25 },
  reportHeader: { backgroundColor: PAGE_GREEN, paddingVertical: 8, paddingHorizontal: 10, flexDirection: "row", justifyContent: "space-between" },
  reportTitle: { fontSize: 11, fontFamily: "Helvetica-Bold", color: "#FFFFFF" },
  reportDate: { fontSize: 8, fontFamily: "Helvetica-Bold", color: "#FFFFFF" },
  summary: { backgroundColor: "#F0F4F2", borderBottomWidth: 0.5, borderBottomColor: "#D4E0DB", flexDirection: "row", paddingVertical: 7, paddingHorizontal: 10, marginBottom: 5 },
  summaryItem: { width: "33.33%" },
  summaryLabel: { fontSize: 6, color: "#5F7A6A", fontFamily: "Helvetica-Bold" },
  summaryValue: { fontSize: 10, color: PAGE_GREEN, fontFamily: "Helvetica-Bold", marginTop: 1 },
  section: { backgroundColor: SECTION_GREEN, color: "#FFFFFF", paddingVertical: 5, paddingHorizontal: 6, fontSize: 8, fontFamily: "Helvetica-Bold", marginTop: 4 },
  tableHeader: { flexDirection: "row", backgroundColor: PAGE_GREEN, color: "#9FE1CB", borderBottomWidth: 0.5, borderBottomColor: "#2D5D4A" },
  tableHeaderCell: { paddingVertical: 4, paddingHorizontal: 2, fontSize: 5.5, fontFamily: "Helvetica-Bold", textTransform: "uppercase", lineHeight: 1.05 },
  fundRow: { flexDirection: "row", backgroundColor: "#5B6066", borderBottomWidth: 1, borderBottomColor: "#454B51" },
  fundCell: { paddingVertical: 5, paddingHorizontal: 2, color: "#FFFFFF", fontSize: 6.4, lineHeight: 1.15 },
  fundName: { fontFamily: "Helvetica-Bold" },
  assetHeader: { flexDirection: "row", backgroundColor: PAGE_GREEN, color: "#9FE1CB" },
  assetRow: { flexDirection: "row", borderBottomWidth: 0.35, borderBottomColor: "#E5E7EB" },
  assetCell: { paddingVertical: 4, paddingHorizontal: 2, fontSize: 6.1, lineHeight: 1.15 },
  assetName: { paddingLeft: 7 },
  right: { textAlign: "right" },
  center: { textAlign: "center" },
  positive: { color: POSITIVE, fontFamily: "Helvetica-Bold" },
  negative: { color: NEGATIVE, fontFamily: "Helvetica-Bold" },
  muted: { color: MUTED },
  noAssets: { fontSize: 6.2, color: "#E5E7EB", fontStyle: "italic" },
  footer: { position: "absolute", left: 22, right: 22, bottom: 10, borderTopWidth: 0.5, borderTopColor: "#E5E7EB", paddingTop: 4, flexDirection: "row", justifyContent: "space-between" },
  footerText: { fontSize: 5.5, color: "#9CA3AF" },
});

function fmtCurrency(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function fmtNumber(value: number | null | undefined, decimals = 4): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPct(value: number | null | undefined, decimals = 4, sign = true): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${sign && value >= 0 ? "+" : ""}${value.toFixed(decimals).replace(".", ",")}%`;
}

function fmtVsCdi(cdiPlusAa: number | null | undefined, pctCdi: number | null | undefined): string {
  if ((cdiPlusAa == null || Number.isNaN(cdiPlusAa)) && (pctCdi == null || Number.isNaN(pctCdi))) return "—";
  if (pctCdi != null && pctCdi < 0) return "—";
  const first = cdiPlusAa == null ? "" : `CDI ${cdiPlusAa >= 0 ? "+" : ""}${cdiPlusAa.toFixed(2).replace(".", ",")}% a.a.`;
  const second = pctCdi == null ? "" : `${pctCdi.toFixed(2).replace(".", ",")}% do CDI`;
  return [first, second].filter(Boolean).join("\n");
}

function numberColor(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return s.muted;
  if (value > 0.001) return s.positive;
  if (value < -0.001) return s.negative;
  return s.muted;
}

function columnStyle(index: number, kind: "header" | "fund" | "asset", align: "left" | "right" = "right") {
  const base = kind === "header" ? s.tableHeaderCell : kind === "fund" ? s.fundCell : s.assetCell;
  return [base, { width: COLUMN_WIDTHS[index] }, align === "right" ? s.right : undefined];
}

function TableHeader({ asset = false }: { asset?: boolean }) {
  const labels = asset
    ? ["Ativo", "Vl. Mercado", "PU", "% PL", "Var. Dia", "vs CDI Dia", "Var. Mês", "vs CDI Mês", "Var. Ano", "vs CDI Ano", "Var. 12M", "vs CDI 12M"]
    : ["Fundo / Ativo", "PL / Qtd", "Cota/PU", "Adm / %PL", "Ret/Var Dia", "vs CDI Dia", "Ret/Var Mês", "vs CDI Mês", "Ret/Var Ano", "vs CDI Ano", "Ret/Var 12M", "vs CDI 12M"];
  return (
    <View style={asset ? s.assetHeader : s.tableHeader}>
      {labels.map((label, index) => (
        <Text key={label} style={columnStyle(index, "header", index === 0 || index === 3 ? "left" : "right")}>{label}</Text>
      ))}
    </View>
  );
}

function FundRow({ fundo }: { fundo: FundoRelatorio }) {
  return (
    <View style={s.fundRow} wrap={false}>
      <Text style={[...columnStyle(0, "fund", "left"), s.fundName]}>{fundo.nome_fundo || "—"}</Text>
      <Text style={columnStyle(1, "fund")}>{fmtCurrency(fundo.pl)}</Text>
      <Text style={columnStyle(2, "fund")}>{fmtNumber(fundo.valor_cota)}</Text>
      <Text style={columnStyle(3, "fund", "left")}>{abreviarAdministrador(fundo.administrador)}</Text>
      <Text style={[...columnStyle(4, "fund"), numberColor(fundo.ret_dia_pct)]}>{fmtPct(fundo.ret_dia_pct)}</Text>
      <Text style={columnStyle(5, "fund")}>{fmtVsCdi(fundo.cdi_plus_aa_dia_pct, fundo.pct_cdi_dia)}</Text>
      <Text style={columnStyle(6, "fund")}>{fmtPct(fundo.ret_mes_pct)}</Text>
      <Text style={columnStyle(7, "fund")}>{fmtVsCdi(fundo.cdi_plus_aa_mes_pct, fundo.pct_cdi_mes)}</Text>
      <Text style={columnStyle(8, "fund")}>{fmtPct(fundo.ret_ano_pct)}</Text>
      <Text style={columnStyle(9, "fund")}>{fmtVsCdi(fundo.cdi_plus_aa_ano_pct, fundo.pct_cdi_ano)}</Text>
      <Text style={columnStyle(10, "fund")}>{fmtPct(fundo.ret_12m_pct, 2)}</Text>
      <Text style={columnStyle(11, "fund")}>{fmtVsCdi(fundo.cdi_plus_aa_12m_pct, fundo.pct_cdi_12m)}</Text>
    </View>
  );
}

function AssetRow({ ativo, index }: { ativo: AtivoRelatorio; index: number }) {
  const backgroundColor = index % 2 === 0 ? "#FFFFFF" : "#FAFAFA";
  return (
    <View style={[s.assetRow, { backgroundColor }]} wrap={false}>
      <Text style={[...columnStyle(0, "asset", "left"), s.assetName]}>{ativo.nome || "—"}</Text>
      <Text style={[...columnStyle(1, "asset"), s.muted]}>{fmtCurrency(ativo.vlMercado)}</Text>
      <Text style={[...columnStyle(2, "asset"), s.muted]}>{fmtNumber(ativo.pu)}</Text>
      <Text style={[...columnStyle(3, "asset"), numberColor(ativo.percPL)]}>{fmtPct(ativo.percPL, 1, false)}</Text>
      <Text style={[...columnStyle(4, "asset"), numberColor(ativo.varDia)]}>{fmtPct(ativo.varDia)}</Text>
      <Text style={[...columnStyle(5, "asset"), numberColor(ativo.cdiPlusAaDia)]}>{fmtVsCdi(ativo.cdiPlusAaDia, ativo.vsCdiDia)}</Text>
      <Text style={[...columnStyle(6, "asset"), numberColor(ativo.varMes)]}>{fmtPct(ativo.varMes)}</Text>
      <Text style={[...columnStyle(7, "asset"), numberColor(ativo.cdiPlusAaMes)]}>{fmtVsCdi(ativo.cdiPlusAaMes, ativo.vsCdiMes)}</Text>
      <Text style={[...columnStyle(8, "asset"), numberColor(ativo.varAno)]}>{fmtPct(ativo.varAno)}</Text>
      <Text style={[...columnStyle(9, "asset"), numberColor(ativo.cdiPlusAaAno)]}>{fmtVsCdi(ativo.cdiPlusAaAno, ativo.vsCdiAno)}</Text>
      <Text style={[...columnStyle(10, "asset"), numberColor(ativo.var12M)]}>{fmtPct(ativo.var12M, 2)}</Text>
      <Text style={[...columnStyle(11, "asset"), numberColor(ativo.cdiPlusAa12m)]}>{fmtVsCdi(ativo.cdiPlusAa12m, ativo.vsCdi12M)}</Text>
    </View>
  );
}

function FundBlock({ fundo }: { fundo: FundoRelatorio }) {
  return (
    <View>
      <FundRow fundo={fundo} />
      {fundo.ativos.length > 0 ? (
        <>
          <TableHeader asset />
          {fundo.ativos.map((ativo, index) => <AssetRow key={`${ativo.nome}-${index}`} ativo={ativo} index={index} />)}
        </>
      ) : (
        <View style={s.fundRow} wrap={false}>
          <Text style={[s.fundCell, s.noAssets]}>Sem ativos na posição nesta data.</Text>
        </View>
      )}
    </View>
  );
}

function Section({ title, fundos }: { title: string; fundos: FundoRelatorio[] }) {
  const pl = fundos.reduce((total, fundo) => total + (fundo.pl ?? 0), 0);
  return (
    <View>
      <Text style={s.section}>{`${title} · ${fundos.length} fundo${fundos.length === 1 ? "" : "s"} · PL: ${fmtCurrency(pl)}`}</Text>
      <TableHeader />
      {fundos.length > 0 ? fundos.map((fundo) => <FundBlock key={`${fundo.fundo_cnpj}-${fundo.nome_fundo}`} fundo={fundo} />) : (
        <Text style={[s.assetCell, s.muted]}>Nenhum fundo nesta categoria.</Text>
      )}
    </View>
  );
}

function RelatorioPDF({ dataRef, fundos, summary, cdiDia, faltantes }: {
  dataRef: string;
  fundos: FundoRelatorio[];
  summary: SummaryData;
  cdiDia: number | null | undefined;
  faltantes: FundoXmlCoverageRow[];
}) {
  const fundosCondominiais = [...fundos].filter((fundo) => !isFundoExclusivoRentabilidade(fundo.nome_fundo)).sort((a, b) => (b.pl ?? 0) - (a.pl ?? 0));
  const fundosExclusivos = [...fundos].filter((fundo) => isFundoExclusivoRentabilidade(fundo.nome_fundo)).sort((a, b) => (b.pl ?? 0) - (a.pl ?? 0));
  const nomesFaltantes = faltantes.map((fundo) => fundo.nome_fundo || fundo.cnpj_fundo).join(" · ");

  return (
    <Document>
      <Page size="A4" orientation="landscape" style={s.page}>
        <View style={s.fixedHeader} fixed>
          <Text style={s.fixedTitle}>Relatório Diário de Rentabilidade</Text>
          <Text style={s.fixedDate}>{dataRef}</Text>
        </View>

        {faltantes.length > 0 && (
          <View style={s.warning}>
            <Text style={s.warningTitle}>Fundos sem XML na data ({faltantes.length})</Text>
            <Text style={s.warningText}>{nomesFaltantes}</Text>
          </View>
        )}

        <View style={s.reportHeader}>
          <Text style={s.reportTitle}>Relatório Diário de Rentabilidade</Text>
          <Text style={s.reportDate}>{dataRef}</Text>
        </View>
        <View style={s.summary}>
          <View style={s.summaryItem}><Text style={s.summaryLabel}>Fundos</Text><Text style={s.summaryValue}>{summary.totalFundos}</Text></View>
          <View style={s.summaryItem}><Text style={s.summaryLabel}>CDI Dia</Text><Text style={s.summaryValue}>{fmtPct(cdiDia)}</Text></View>
          <View style={s.summaryItem}><Text style={s.summaryLabel}>PL Total</Text><Text style={s.summaryValue}>{fmtCurrency(summary.plTotal)}</Text></View>
        </View>

        <Section title="Fundos Condominiais" fundos={fundosCondominiais} />
        <Section title="Fundos Exclusivos" fundos={fundosExclusivos} />

        <View style={s.footer} fixed>
          <Text style={s.footerText}>Notificação automática · Hub Risco</Text>
          <Text style={s.footerText} render={({ pageNumber, totalPages }) => `Página ${pageNumber} de ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function generateRentabilidadeRelatorioPDF(
  dataRef: string,
  fundos: FundoRelatorio[],
  summary: SummaryData,
  cdiDia: number | null | undefined,
  faltantes: FundoXmlCoverageRow[] = [],
): Promise<Blob> {
  return pdf(<RelatorioPDF dataRef={dataRef} fundos={fundos} summary={summary} cdiDia={cdiDia} faltantes={faltantes} />).toBlob();
}

export function downloadPDF(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function downloadRentabilidadeRelatorioPDF(
  dataRef: string,
  fundos: FundoRelatorio[],
  summary: SummaryData,
  cdiDia: number | null | undefined,
  faltantes: FundoXmlCoverageRow[] = [],
): Promise<void> {
  const blob = await generateRentabilidadeRelatorioPDF(dataRef, fundos, summary, cdiDia, faltantes);
  downloadPDF(blob, `rentabilidade_${dataRef.replace(/\//g, "-")}.pdf`);
}
