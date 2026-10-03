export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      user_profiles: {
        Row: {
          id: string
          full_name: string | null
          access_type: "completo" | "consulta"
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          full_name?: string | null
          access_type?: "completo" | "consulta"
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          full_name?: string | null
          access_type?: "completo" | "consulta"
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_menu_permissions: {
        Row: {
          user_id: string
          menu_key: string
          created_at: string
        }
        Insert: {
          user_id: string
          menu_key: string
          created_at?: string
        }
        Update: {
          user_id?: string
          menu_key?: string
          created_at?: string
        }
        Relationships: []
      }
      finvest_fundos: {
        Row: {
          id: string
          codigo: string
          nome: string
          ativo: boolean
          created_at: string
          updated_at: string
          created_by: string | null
        }
        Insert: {
          id?: string
          codigo: string
          nome: string
          ativo?: boolean
          created_at?: string
          updated_at?: string
          created_by?: string | null
        }
        Update: {
          id?: string
          codigo?: string
          nome?: string
          ativo?: boolean
          created_at?: string
          updated_at?: string
          created_by?: string | null
        }
        Relationships: []
      }
      liquidez_monitoramento_risco: {
        Row: {
          id: string
          fundo_cnpj: string
          dt_posicao: string
          total_pl: number | null
          is_fundo_fechado: boolean
          prazo_resgate: number | null
          indice_liquidez: number | null
          status: string
          intermediate_status: string | null
          meses_cobertura: number | null
          status_cobertura: string | null
          disp_pl: number | null
          fonte_despesa: string | null
          calculado_em: string
        }
        Insert: {
          id?: string
          fundo_cnpj: string
          dt_posicao: string
          total_pl?: number | null
          is_fundo_fechado?: boolean
          prazo_resgate?: number | null
          indice_liquidez?: number | null
          status: string
          intermediate_status?: string | null
          meses_cobertura?: number | null
          status_cobertura?: string | null
          disp_pl?: number | null
          fonte_despesa?: string | null
          calculado_em?: string
        }
        Update: {
          id?: string
          fundo_cnpj?: string
          dt_posicao?: string
          total_pl?: number | null
          is_fundo_fechado?: boolean
          prazo_resgate?: number | null
          indice_liquidez?: number | null
          status?: string
          intermediate_status?: string | null
          meses_cobertura?: number | null
          status_cobertura?: string | null
          disp_pl?: number | null
          fonte_despesa?: string | null
          calculado_em?: string
        }
        Relationships: []
      }
      ativos: {
        Row: {
          id: string
          tipo_ativo: string
          descricao: string | null
          nome_frontend: string | null
          isin: string | null
          cnpj: string | null
          ticker: string | null
          codigo_cetip_selic: string | null
          matricula_imovel: string | null
          endereco_imovel: string | null
          validado: boolean
          prazo_liquidez_manual_dias: number | null
          prazo_duracao_fundo_anos: number | null
          created_at: string
          updated_at: string | null
        }
        Insert: {
          id?: string
          tipo_ativo: string
          descricao?: string | null
          nome_frontend?: string | null
          isin?: string | null
          cnpj?: string | null
          ticker?: string | null
          codigo_cetip_selic?: string | null
          matricula_imovel?: string | null
          endereco_imovel?: string | null
          validado?: boolean
          prazo_liquidez_manual_dias?: number | null
          prazo_duracao_fundo_anos?: number | null
          created_at?: string
          updated_at?: string | null
          [key: string]: Json
        }
        Update: {
          id?: string
          tipo_ativo?: string
          descricao?: string | null
          nome_frontend?: string | null
          isin?: string | null
          cnpj?: string | null
          ticker?: string | null
          codigo_cetip_selic?: string | null
          matricula_imovel?: string | null
          endereco_imovel?: string | null
          validado?: boolean
          prazo_liquidez_manual_dias?: number | null
          prazo_duracao_fundo_anos?: number | null
          created_at?: string
          updated_at?: string | null
          [key: string]: Json
        }
        Relationships: []
      }
      posicao_carteira: {
        Row: {
          id: string
          natural_key: string
          arquivo_nome: string | null
          section: string
          possui_compromisso: boolean | null
          fundo_isin: string | null
          fundo_cnpj: string
          nome_fundo: string | null
          fundo_dtposicao: string | null
          fundo_nomeadm: string | null
          fundo_cnpjadm: string | null
          fundo_nomegestor: string | null
          fundo_cnpjgestor: string | null
          fundo_nomecustodiante: string | null
          fundo_cnpjcustodiante: string | null
          fundo_valorcota: number | null
          fundo_quantidade: number | null
          fundo_patliq: number | null
          fundo_valorativos: number | null
          fundo_valorreceber: number | null
          fundo_valorpagar: number | null
          fundo_vlcotasemitir: number | null
          fundo_vlcotasresgatar: number | null
          fundo_codanbid: string | null
          fundo_tipofundo: string | null
          fundo_nivelrsc: string | null
          isin: string | null
          codativo: string | null
          cusip: string | null
          cnpjfundo: string | null
          cnpjemissor: string | null
          idinternoativo: string | null
          dtemissao: string | null
          dtoperacao: string | null
          dtvencimento: string | null
          qtdisponivel: number | null
          qtgarantia: number | null
          pucompra: number | null
          puposicao: number | null
          puvencimento: number | null
          puemissao: number | null
          principal: number | null
          valorfindisp: number | null
          valorfinemgar: number | null
          tributos: number | null
          valorfinanceiro: number | null
          indexador: string | null
          percindex: number | null
          coupom: number | null
          caracteristica: string | null
          classeoperacao: string | null
          depgar: string | null
          percprovcred: number | null
          nivelrsc: string | null
          compromisso_dtretorno: string | null
          compromisso_puretorno: number | null
          compromisso_indexadorcomp: string | null
          compromisso_perindexcomp: number | null
          compromisso_txoperacao: number | null
          compromisso_classecomp: string | null
          isininstituicao: string | null
          tpconta: string | null
          saldo: number | null
          txadm: number | null
          perctaxaadm: number | null
          txperf: string | null
          vltxperf: number | null
          perctxperf: number | null
          outtax: number | null
          codprov: string | null
          credeb: string | null
          dt: string | null
          valor: number | null
          valor_padrao: number | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          natural_key: string
          fundo_cnpj: string
          section: string
          [key: string]: Json
        }
        Update: {
          id?: string
          [key: string]: Json
        }
        Relationships: []
      }
      enquadramentos: {
        Row: {
          id: string
          nome: string
          descricao: string | null
          status: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          nome: string
          descricao?: string | null
          status?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          nome?: string
          descricao?: string | null
          status?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      enquadramento_resultado: {
        Row: {
          id: string
          fundo_cnpj: string
          fundo_dtposicao: string
          regra_categoria: 'pl' | 'concentration' | 'liquidity' | 'classe' | 'relacional' | 'relational' | 'fidc-concentracao' | 'fidc-estrutura'
          regra_codigo: string
          regra_descricao: string | null
          status: 'ok' | 'alerta' | 'violacao'
          valor_atual: number | null
          valor_limite: number | null
          detalhes: Json | null
          verificado_em: string
        }
        Insert: {
          id?: string
          fundo_cnpj: string
          fundo_dtposicao: string
          regra_categoria: 'pl' | 'concentration' | 'liquidity' | 'classe' | 'relacional' | 'relational' | 'fidc-concentracao' | 'fidc-estrutura'
          regra_codigo: string
          regra_descricao?: string | null
          status: 'ok' | 'alerta' | 'violacao'
          valor_atual?: number | null
          valor_limite?: number | null
          detalhes?: Json | null
          verificado_em?: string
        }
        Update: {
          id?: string
          fundo_cnpj?: string
          fundo_dtposicao?: string
          regra_categoria?: 'pl' | 'concentration' | 'liquidity' | 'classe' | 'relacional' | 'relational' | 'fidc-concentracao' | 'fidc-estrutura'
          regra_codigo?: string
          regra_descricao?: string | null
          status?: 'ok' | 'alerta' | 'violacao'
          valor_atual?: number | null
          valor_limite?: number | null
          detalhes?: Json | null
          verificado_em?: string
        }
        Relationships: []
      }
      liquidez_monitoramento_risco: {
        Row: {
          id: string
          fundo_cnpj: string
          fundo_dtposicao: string
          total_pl: number
          is_fundo_fechado: boolean
          prazo_resgate: number | null
          indice_liquidez: number | null
          status: 'ok' | 'alerta' | 'violacao' | 'pendente'
          intermediate_status: 'ok' | 'alerta' | 'violacao' | null
          atualizado_em: string
        }
        Insert: {
          id?: string
          fundo_cnpj: string
          fundo_dtposicao: string
          total_pl?: number
          is_fundo_fechado?: boolean
          prazo_resgate?: number | null
          indice_liquidez?: number | null
          status: 'ok' | 'alerta' | 'violacao' | 'pendente'
          intermediate_status?: 'ok' | 'alerta' | 'violacao' | null
          atualizado_em?: string
        }
        Update: {
          id?: string
          fundo_cnpj?: string
          fundo_dtposicao?: string
          total_pl?: number
          is_fundo_fechado?: boolean
          prazo_resgate?: number | null
          indice_liquidez?: number | null
          status?: 'ok' | 'alerta' | 'violacao' | 'pendente'
          intermediate_status?: 'ok' | 'alerta' | 'violacao' | null
          atualizado_em?: string
        }
        Relationships: []
      }
      credito_estoque_recebiveis: {
        Row: {
          id: string
          import_id: string
          nome_fundo: string | null
          doc_fundo: string | null
          data_referencia: string
          data_vencimento_ajustada: string | null
          situacao_recebivel: string | null
          valor_presente: number
          valor_pdd_atual: number
          faixa_pdd_arquivo: string | null
          dias_atraso: number
          bucket_atraso: string
          source_filename: string | null
          criado_em: string | null
        }
        Insert: {
          id?: string
          import_id: string
          nome_fundo?: string | null
          doc_fundo?: string | null
          data_referencia: string
          data_vencimento_ajustada?: string | null
          situacao_recebivel?: string | null
          valor_presente?: number
          valor_pdd_atual?: number
          faixa_pdd_arquivo?: string | null
          dias_atraso?: number
          bucket_atraso: string
          source_filename?: string | null
          criado_em?: string | null
        }
        Update: {
          id?: string
          import_id?: string
          nome_fundo?: string | null
          doc_fundo?: string | null
          data_referencia?: string
          data_vencimento_ajustada?: string | null
          situacao_recebivel?: string | null
          valor_presente?: number
          valor_pdd_atual?: number
          faixa_pdd_arquivo?: string | null
          dias_atraso?: number
          bucket_atraso?: string
          source_filename?: string | null
          criado_em?: string | null
        }
        Relationships: []
      }
      credito_estoque_resumo_bucket: {
        Row: {
          id: string
          import_id: string
          nome_fundo: string
          doc_fundo: string | null
          data_referencia: string
          bucket_atraso: string
          exposicao: number
          pdd_atual: number
          pdd_modelo: number
          gap: number
          cobertura: number
          criado_em: string | null
        }
        Insert: {
          id?: string
          import_id: string
          nome_fundo: string
          doc_fundo?: string | null
          data_referencia: string
          bucket_atraso: string
          exposicao?: number
          pdd_atual?: number
          pdd_modelo?: number
          gap?: number
          cobertura?: number
          criado_em?: string | null
        }
        Update: {
          id?: string
          import_id?: string
          nome_fundo?: string
          doc_fundo?: string | null
          data_referencia?: string
          bucket_atraso?: string
          exposicao?: number
          pdd_atual?: number
          pdd_modelo?: number
          gap?: number
          cobertura?: number
          criado_em?: string | null
        }
        Relationships: []
      }
      credito_estoque_indicadores: {
        Row: {
          id: string
          import_id: string
          nome_fundo: string
          doc_fundo: string | null
          data_referencia: string
          carteira_total: number
          over90: number
          over180: number
          coverage_vencidos: number
          gap_total: number
          pdd_atual_total: number
          pdd_modelo_total: number
          criado_em: string | null
        }
        Insert: {
          id?: string
          import_id: string
          nome_fundo: string
          doc_fundo?: string | null
          data_referencia: string
          carteira_total?: number
          over90?: number
          over180?: number
          coverage_vencidos?: number
          gap_total?: number
          pdd_atual_total?: number
          pdd_modelo_total?: number
          criado_em?: string | null
        }
        Update: {
          id?: string
          import_id?: string
          nome_fundo?: string
          doc_fundo?: string | null
          data_referencia?: string
          carteira_total?: number
          over90?: number
          over180?: number
          coverage_vencidos?: number
          gap_total?: number
          pdd_atual_total?: number
          pdd_modelo_total?: number
          criado_em?: string | null
        }
        Relationships: []
      }
      matriz_anbima: {
        Row: {
          id: string
          data_ref: string
          periodo: string
          classe: string
          segmento_investidor: string
          tipo_metodologia: string
          metrica: string
          prazo: number
          valor: number
          criado_em: string | null
        }
        Insert: {
          id?: string
          data_ref: string
          periodo: string
          classe: string
          segmento_investidor: string
          tipo_metodologia: string
          metrica: string
          prazo: number
          valor: number
          criado_em?: string | null
        }
        Update: {
          id?: string
          data_ref?: string
          periodo?: string
          classe?: string
          segmento_investidor?: string
          tipo_metodologia?: string
          metrica?: string
          prazo?: number
          valor?: number
          criado_em?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
