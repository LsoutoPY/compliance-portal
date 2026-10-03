import type { RiscoModulo, RiscoNivel, RiscoPlanoStatus, RiscoValidadeOcorrencia, RiscoWorkflowStatus } from "@/types/relatorios-risco";

export type RiscoEpisodio = {
  id: string;
  modulo: RiscoModulo;
  fundo_cnpj: string;
  fundo_isin: string;
  fundo_nome: string;
  source_key: string;
  source_table: string;
  titulo: string;
  descricao: string | null;
  nivel_atual: RiscoNivel;
  violacao_detectada: boolean;
  data_inicio: string;
  data_ultima_evidencia: string;
  data_regularizacao: string | null;
  dias_com_evidencia: number;
  dias_episodio: number;
  valor_atual: number | null;
  valor_pior: number | null;
  limite_referencia: number | null;
  unidade: string | null;
  status_workflow: RiscoWorkflowStatus;
  validade_ocorrencia: RiscoValidadeOcorrencia;
  motivo_classificacao: string | null;
  notificacao_pendente: boolean;
  notificacao_manual_em: string | null;
  notificacao_manual_destinatarios: string[] | null;
  notificacao_manual_observacao: string | null;
  plano_id: string | null;
  plano_versao: number | null;
  plano_conteudo: string | null;
  plano_responsavel_nome: string | null;
  plano_responsavel_email: string | null;
  plano_prazo: string | null;
  plano_recebido_em: string | null;
  plano_status: RiscoPlanoStatus | null;
};

export type RiscoEpisodioPlanoInput = {
  episodioId: string;
  conteudo: string;
  responsavelNome?: string;
  responsavelEmail?: string;
  prazo?: string;
  origem: "manual" | "email";
};
