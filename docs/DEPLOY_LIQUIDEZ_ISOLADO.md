# Implantação do módulo FIDC mensal no fork CVPAR

Status em 24/09/2026: o usuário confirmou que `gwdtyorogmfijleoydvm` é o fork escolhido do Frame Control Center e autorizou seguir. Foram aplicadas `20260923010000`, `20260923020000` e `20260924010000`; `supabase db push --linked --dry-run` retornou `upToDate: true`. As funções `import-liquidity-monthly-cvm` (versão 2), `import-liquidity-position` e `calculate-liquidity-monthly` (versão 1) estão `ACTIVE`, com `verify_jwt: true`. A função legado `import-cvm-informe-mensal` permanece `ACTIVE`, versão 2. Um teste HTTP retornou 200 em `OPTIONS` e 401 em `POST` sem token nas três funções novas. O fluxo autenticado também foi executado: junho e julho tiveram 141 grupos de tabelas gravados cada; a Carteira Diária NC de junho foi importada; oito fundos foram calculados em cada mês.

## Seleção de migrations

Este repositório contém mais de 200 migrations de outros módulos. Não executar `supabase db push` indiscriminadamente em um projeto novo. Para o módulo mensal sobre o portal base, aplicar em ordem:

1. `0001_init.sql` a `0006_xml_posicao.sql`;
2. `20260715010000_user_profiles_access_control.sql` (cria `user_profiles`, `user_is_active` e `user_can_write` usados nas políticas novas);
3. `20260923010000_liquidity_monthly_validation.sql`;
4. `20260923020000_liquidity_monthly_report_mapping.sql`;
5. `20260924010000_liquidity_monthly_cvpar_funds.sql`.

Antes de aplicar, verificar em `supabase_migrations.schema_migrations` quais já existem. Não repetir seeds ou funções com outro histórico sem comparar a estrutura do alvo. Em instalação vazia, criar o usuário de Risco pelo Supabase Auth, ativar seu `user_profiles` e conferir o perfil `profiles.role`; nunca colocar credenciais no frontend.

## Edge Functions do módulo

- `import-liquidity-monthly-cvm` (endpoint dedicado; preserva a função ativa `import-cvm-informe-mensal` do Frame)
- `import-liquidity-position`
- `calculate-liquidity-monthly`

As três usam JWT de usuário ativo com permissão de Risco. As duas importações guardam o arquivo original em Storage privado e registram origem/hashes. `calculate-liquidity-monthly` grava uma execução versionada em `liquidity_monthly_runs`.

## Validação após implantação

1. Confirmar que URL e `VITE_SUPABASE_ANON_KEY` da aplicação apontam para o projeto isolado, sem chave `service_role` no frontend.
2. Enviar os ZIPs CVM pela aba **Dados → Importar → Informes CVM**; conferir logs `ingest_runs`, grupos gravados e SHA dos arquivos privados. Para novos meses, selecionar a competência correspondente antes do envio.
3. O envio do ZIP mensal calcula automaticamente os CNPJs encontrados, em lotes de quatro. Enviar a Carteira Diária NC de 30/06/2026 em **Dados e parâmetros** e recalcular o NC de junho para incorporar a posição; consultar a **Base do portal** em `/liquidez/mensal`. Isso já foi executado para a amostra de junho/julho.
4. Confrontar os valores e divergências descritos em `VALIDACAO_LIQUIDEZ_CVPAR_2026.md`. Confirmar especialmente PL, PDD, vencidos, subordinação e as divergências de EDUC/I/II. Testar leitura de Compliance e bloqueio de escrita.

Os números embutidos na prévia local são apenas uma amostra verificável dos arquivos originais enviados. Em produção, a página abre por padrão na **Base do portal**.

Em 24/09/2026, a função `import-liquidity-monthly-cvm` foi republicada com `cnpjs_imported` na resposta. Um novo upload do ZIP original de julho pela interface gravou 141 grupos e exibiu **8/8 fundos calculados** sem acionamento manual. O relatório abriu com as oito opções de fundo e mostrou, por exemplo, PL do EDUC de R$ 123.357.518,32. Esse teste verifica o encadeamento importação → cálculo → consulta no fork; não substitui a revisão independente das fórmulas nem um teste de carga com mais de 50 fundos.

## Permissão do operador

A conta autenticada `luiz.souto@cvparquadrante.com.br` tinha `user_profiles.access_type=consulta`, `is_active=false` e nenhum registro em `profiles`; por isso a ação aparecia desabilitada. Em 24/09/2026, após o pedido de habilitar a importação, foi criado `profiles.role=risco` e ativado `user_profiles.is_active=true` **apenas nessa conta**. O acesso geral permaneceu `consulta`. A Edge Function continua recusando ausência de JWT, conta inativa e perfil Compliance. A interface agora apresenta o estado da permissão e oferece login no próprio painel. Mudanças de perfil de outras contas exigem identificação e autorização específicas.

Leia [METODOLOGIA_LIQUIDEZ_FIDC.md](METODOLOGIA_LIQUIDEZ_FIDC.md) antes de alterar fórmulas ou ampliar o universo de fundos.
