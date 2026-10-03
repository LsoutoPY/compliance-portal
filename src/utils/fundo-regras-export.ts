/**
 * Modelo XLSX para importação em lote de vínculos fundo × regra.
 * Cabeçalho verde #003D27 — identidade visual do Frame Control Center.
 */

import ExcelJS from "exceljs";

const GREEN_HEADER = "FF003D27";
const GREEN_LIGHT = "FFE8F5EF";
const BORDER = "FFD1D5DB";

const EXAMPLE_ROWS = [
  {
    fundo_cnpj: "12.345.678/0001-90",
    fundo_nome: "FIDC Exemplo JR",
    fundo_isin: "BR0000000001",
    codigo_regra: "LIMITE_PROFISSIONAL_10",
    dt_inicio: "01/01/2026",
    dt_fim: "",
  },
  {
    fundo_cnpj: "98.765.432/0001-10",
    fundo_nome: "FIM Exemplo",
    fundo_isin: "",
    codigo_regra: "TRIB_FIQ_LP_90",
    dt_inicio: "01/03/2026",
    dt_fim: "31/12/2026",
  },
];

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadFundoRegrasImportTemplate(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Frame Control Center";
  const ws = wb.addWorksheet("Vinculos", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const headers = [
    "fundo_cnpj",
    "fundo_nome",
    "fundo_isin",
    "codigo_regra",
    "dt_inicio_vigencia",
    "dt_fim_vigencia",
  ];

  const headerLabels = [
    "CNPJ do fundo",
    "Nome do fundo (alternativo)",
    "ISIN subclasse (opcional)",
    "Código da regra",
    "Início vigência (DD/MM/AAAA)",
    "Fim vigência (DD/MM/AAAA)",
  ];

  ws.columns = headers.map((key, i) => ({
    key,
    width: i === 1 ? 36 : i === 3 ? 28 : 22,
  }));

  const headerRow = ws.addRow(Object.fromEntries(headers.map((h, i) => [h, headerLabels[i]])));
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN_HEADER } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10, name: "Calibri" };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: BORDER } },
      left: { style: "thin", color: { argb: BORDER } },
      bottom: { style: "thin", color: { argb: BORDER } },
      right: { style: "thin", color: { argb: BORDER } },
    };
  });

  for (const ex of EXAMPLE_ROWS) {
    const row = ws.addRow({
      fundo_cnpj: ex.fundo_cnpj,
      fundo_nome: ex.fundo_nome,
      fundo_isin: ex.fundo_isin,
      codigo_regra: ex.codigo_regra,
      dt_inicio_vigencia: ex.dt_inicio,
      dt_fim_vigencia: ex.dt_fim,
    });
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN_LIGHT } };
      cell.font = { size: 10, name: "Calibri", color: { argb: "FF1A1A2E" } };
      cell.border = {
        top: { style: "thin", color: { argb: BORDER } },
        left: { style: "thin", color: { argb: BORDER } },
        bottom: { style: "thin", color: { argb: BORDER } },
        right: { style: "thin", color: { argb: BORDER } },
      };
    });
  }

  ws.addRow({});
  const noteRow = ws.addRow({
    fundo_cnpj:
      "Preencha CNPJ ou nome do fundo. Vínculos importados ficam pendentes de autorização antes de entrar no enquadramento.",
  });
  noteRow.getCell(1).font = { italic: true, size: 9, color: { argb: "FF5B6066" } };
  ws.mergeCells(noteRow.number, 1, noteRow.number, 6);

  const buffer = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "modelo-vinculos-fundo-regra.xlsx",
  );
}
