import type { TipoAtivo } from "@/types/gestao-credito";
import { invokeAuthenticatedFunction } from "@/lib/supabaseFunctions";

export interface ReceitaWsAtividade {
  code: string;
  text: string;
}

export interface ReceitaWsEmpresa {
  status: string;
  cnpj?: string;
  nome?: string;
  fantasia?: string;
  tipo?: string;
  porte?: string;
  abertura?: string;
  situacao?: string;
  data_situacao?: string;
  natureza_juridica?: string;
  atividade_principal?: ReceitaWsAtividade[];
  atividades_secundarias?: ReceitaWsAtividade[];
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  municipio?: string;
  uf?: string;
  cep?: string;
  email?: string;
  telefone?: string;
  capital_social?: string;
  ultima_atualizacao?: string;
  message?: string;
}

export interface ConsultaCnpjReceitaResponse {
  success: boolean;
  data?: ReceitaWsEmpresa;
  error?: string;
  code?: "INVALID_CNPJ" | "NOT_FOUND" | "RATE_LIMIT" | "TIMEOUT" | "UPSTREAM";
}

export function cleanCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "").slice(0, 14);
}

export function isCnpjComplete(cnpj: string): boolean {
  return cleanCnpj(cnpj).length === 14;
}

function atividadePrincipal(data: ReceitaWsEmpresa): ReceitaWsAtividade | undefined {
  return data.atividade_principal?.[0];
}

function cnaeDigits(code: string | undefined): string {
  return (code ?? "").replace(/\D/g, "");
}

/** Sugere tipo de ativo com base na CNAE e natureza jurídica. */
export function inferTipoAtivoFromReceita(data: ReceitaWsEmpresa): TipoAtivo | null {
  const principal = atividadePrincipal(data);
  const cnae = cnaeDigits(principal?.code);
  const texto = (principal?.text ?? "").toLowerCase();
  const rotulos = `${data.nome ?? ""} ${data.fantasia ?? ""}`.toLowerCase();
  const natureza = (data.natureza_juridica ?? "").toLowerCase();

  if (
    cnae.startsWith("64") ||
    texto.includes("banco") ||
    texto.includes("intermedia") ||
    natureza.includes("banco")
  ) {
    return "IF";
  }

  if (
    rotulos.includes("fidc") ||
    texto.includes("direitos credit") ||
    texto.includes("securitiza")
  ) {
    return "ESTRUTURADO";
  }

  if (
    cnae.startsWith("663") ||
    texto.includes("administra") && texto.includes("fundos") ||
    texto.includes("gestão de carteiras") ||
    texto.includes("gestao de carteiras")
  ) {
    return "COTA_FUNDO";
  }

  if (texto || rotulos) return "CORPORATIVO";
  return null;
}

/** Sugere instrumento quando o perfil Receita indica FIDC. */
export function inferInstrumentoFromReceita(data: ReceitaWsEmpresa): string | null {
  const rotulos = `${data.nome ?? ""} ${data.fantasia ?? ""}`.toLowerCase();
  const texto = (atividadePrincipal(data)?.text ?? "").toLowerCase();
  if (rotulos.includes("fidc") || texto.includes("direitos credit")) return "FIDC";
  return null;
}

function formatCapitalSocial(valor: string | undefined): string | null {
  if (!valor) return null;
  const n = Number.parseFloat(valor.replace(",", "."));
  if (!Number.isFinite(n)) return valor;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatEndereco(data: ReceitaWsEmpresa): string | null {
  const partes = [
    [data.logradouro, data.numero].filter(Boolean).join(", "),
    data.complemento,
    data.bairro,
    [data.municipio, data.uf].filter(Boolean).join("/"),
    data.cep,
  ].filter(Boolean);
  return partes.length ? partes.join(" — ") : null;
}

/** Texto base para o campo Breve Histórico (step 2). */
export function buildResumoEmissorReceita(data: ReceitaWsEmpresa): string {
  const principal = atividadePrincipal(data);
  const linhas = [
    "Dados cadastrais (Receita Federal — consulta automática):",
    data.nome && `Razão social: ${data.nome}`,
    data.fantasia && data.fantasia !== data.nome && `Nome fantasia: ${data.fantasia}`,
    data.cnpj && `CNPJ: ${data.cnpj}`,
    data.situacao && `Situação cadastral: ${data.situacao}${data.data_situacao ? ` (desde ${data.data_situacao})` : ""}`,
    data.abertura && `Data de abertura: ${data.abertura}`,
    data.natureza_juridica && `Natureza jurídica: ${data.natureza_juridica}`,
    data.porte && `Porte: ${data.porte}`,
    formatCapitalSocial(data.capital_social) && `Capital social: ${formatCapitalSocial(data.capital_social)}`,
    principal?.text && `Atividade principal: ${principal.code ? `${principal.code} — ` : ""}${principal.text}`,
    formatEndereco(data) && `Endereço: ${formatEndereco(data)}`,
    data.telefone && `Telefone: ${data.telefone}`,
    data.email && `E-mail: ${data.email}`,
  ].filter(Boolean) as string[];

  return linhas.join("\n");
}

export async function consultarCnpjReceita(cnpj: string): Promise<ConsultaCnpjReceitaResponse> {
  const digits = cleanCnpj(cnpj);
  if (digits.length !== 14) {
    return { success: false, error: "CNPJ incompleto.", code: "INVALID_CNPJ" };
  }

  const { data, error } = await invokeAuthenticatedFunction<ConsultaCnpjReceitaResponse>(
    "consultar-cnpj-receita",
    { cnpj: digits },
  );

  if (error) {
    return { success: false, error: error.message, code: "UPSTREAM" };
  }

  if (!data?.success) {
    return {
      success: false,
      error: data?.error ?? "Não foi possível consultar o CNPJ.",
      code: data?.code ?? "UPSTREAM",
    };
  }

  return { success: true, data: data.data };
}
