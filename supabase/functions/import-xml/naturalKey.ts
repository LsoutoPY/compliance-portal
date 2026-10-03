const BASE_KEY_FIELDS = [
  "fundo_cnpj",
  "fundo_isin",
  "fundo_dtposicao",
  "section",
  "codativo",
  "isin",
  "codprov",
  "coddesp",
  "dtoperacao",
  "valor",
  "matricula",
  "cnpjpart",
  "nomecomercial",
  "saldo",
  "txadm",
  "cnpjfundo",
  "qtdisponivel",
] as const;

const SECTION_KEY_FIELDS: Record<string, readonly string[]> = {
  imoveis: ["valorcontabil", "logradouro", "numero", "complemento", "cep", "tipoimovel", "cnpjemp"],
  caixa: ["isininstituicao", "tpconta"],
  despesas: ["txperf", "vltxperf", "perctxperf", "outtax"],
  provisao: ["credeb", "dt"],
  titpublico: ["cusip", "cnpjemissor", "dtemissao", "dtvencimento", "idinternoativo"],
  titprivado: ["cusip", "cnpjemissor", "dtemissao", "dtvencimento", "idinternoativo"],
  termorf: ["cusip", "cnpjemissor", "dtemissao", "dtvencimento", "idinternoativo"],
  participacoes: ["cnpjemissor", "valorfinanceiro"],
  fidc: ["cnpjemissor", "valorfinanceiro"],
};

export function getNaturalKeyFields(sectionName: string): string[] {
  return [...BASE_KEY_FIELDS, ...(SECTION_KEY_FIELDS[sectionName.toLowerCase()] ?? [])];
}

export function buildNaturalKeySeed(
  record: Record<string, unknown>,
  sectionName: string,
): string {
  return getNaturalKeyFields(sectionName)
    .map((field) => String(record[field] ?? ""))
    .join("-");
}
