export type RiscoModulo = "enquadramento" | "liquidez" | "mercado" | "concentracao";

export type RiscoNivel = "atencao" | "violacao";

export type RiscoWorkflowStatus =
  | "aberta"
  | "aguardando_plano"
  | "em_tratamento"
  | "regularizada"
  | "encerrada";

export type RiscoNotificacaoStatus = "nao_enviada" | "enviada" | "erro" | "dispensada";

export type RiscoPlanoStatus = "recebido" | "em_execucao" | "concluido" | "substituido";

export type RiscoValidadeOcorrencia =
  | "confirmada"
  | "em_revisao"
  | "invalidada_correcao_dado";

export type RiscoMotivoValidade =
  | "xml_incorreto"
  | "arquivo_reprocessado"
  | "regra_incorreta"
  | "duplicidade"
  | "em_analise"
  | "outro";

export type RiscoOcorrenciaMensal = {
  id: string;
  competencia: string;
  modulo: RiscoModulo;
  fundo_cnpj: string;
  fundo_isin: string;
  fundo_nome: string;
  nivel: RiscoNivel;
  source_key: string;
  source_table: string;
  titulo: string;
  descricao: string | null;
  data_primeira: string;
  data_ultima: string;
  dias_ocorrencia: number;
  valor_pior: number | null;
  limite_referencia: number | null;
  unidade: string | null;
  status_workflow: RiscoWorkflowStatus;
  validade_ocorrencia: RiscoValidadeOcorrencia;
  invalidada_em: string | null;
  invalidada_por: string | null;
  motivo_invalidacao: string | null;
  motivo_classificacao: RiscoMotivoValidade | null;
  validade_bloqueada_manualmente: boolean;
  validade_atualizada_em: string | null;
  validade_atualizada_por: string | null;
  ultima_sincronizacao_id: string | null;
  notificacao_status: RiscoNotificacaoStatus;
  notificacao_enviada_em: string | null;
  notificacao_email_id: string | null;
  source_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  plano_id: string | null;
  plano_versao: number | null;
  plano_conteudo: string | null;
  plano_responsavel_nome: string | null;
  plano_responsavel_email: string | null;
  plano_prazo: string | null;
  plano_recebido_em: string | null;
  plano_status: RiscoPlanoStatus | null;
  plano_origem: "manual" | "email" | "integracao" | null;
};

export type RiscoComunicacao = {
  id: string;
  ocorrencia_id: string;
  tipo: "notificacao_enviada" | "resposta_recebida" | "comentario" | "evidencia" | "status_alterado" | "validade_alterada";
  canal: "sistema" | "email" | "manual" | "integracao";
  remetente: string | null;
  destinatarios: string[];
  assunto: string | null;
  conteudo: string | null;
  created_at: string;
};

export type RiscoRelatorioMensal = {
  id: string;
  competencia: string;
  status: "rascunho" | "em_revisao" | "aprovado" | "arquivado";
  manifestacao_diretor: string | null;
  ressalvas: string | null;
  aprovado_em: string | null;
  arquivo_url: string | null;
  updated_at: string;
};

export type RiscoPlanoInput = {
  ocorrenciaId: string;
  conteudo: string;
  responsavelNome?: string;
  responsavelEmail?: string;
  prazo?: string;
  origem?: "manual" | "email" | "integracao";
};

export type RiscoValidadeInput = {
  ocorrenciaId: string;
  validade: RiscoValidadeOcorrencia;
  motivo: RiscoMotivoValidade | null;
};

export const RISCO_MODULO_LABEL: Record<RiscoModulo, string> = {
  enquadramento: "Enquadramento",
  liquidez: "Liquidez",
  mercado: "Mercado",
  concentracao: "Concentração",
};

export const RISCO_WORKFLOW_LABEL: Record<RiscoWorkflowStatus, string> = {
  aberta: "Aberta",
  aguardando_plano: "Aguardando plano",
  em_tratamento: "Em tratamento",
  regularizada: "Regularizada",
  encerrada: "Encerrada",
};

export const RISCO_VALIDADE_LABEL: Record<RiscoValidadeOcorrencia, string> = {
  confirmada: "Confirmada",
  em_revisao: "Em revisão",
  invalidada_correcao_dado: "Indevida — erro de dados",
};

export const RISCO_MOTIVO_VALIDADE_LABEL: Record<RiscoMotivoValidade, string> = {
  xml_incorreto: "XML incorreto",
  arquivo_reprocessado: "Arquivo substituído ou reprocessado",
  regra_incorreta: "Regra configurada incorretamente",
  duplicidade: "Ocorrência duplicada",
  em_analise: "Em análise",
  outro: "Outro motivo",
};
