# Portal CVPAR — revisão técnica e visual

Data: 17/09/2026. Prioridades: P0 = bloqueador para operar com dados reais; P1 = necessário à confiabilidade do relatório; P2 = organização/experiência/manutenção.

Escopo executado: inventário de todo o diretório; leitura dos contratos e rotas; revisão aprofundada de autenticação, permissões, migrations de acesso aberto, ingestão mensal, motor de liquidez, persistência, relatórios e estilos; leitura das sete abas do Excel; `tsc --noEmit`; abertura do mockup e portal no Edge a 1440 × 1000. Não equivale a auditoria linha a linha das 215 migrations ou de todas as funções do fork. Sem acesso ao estado implantado do Supabase. Chamadas externas bloqueadas durante inspeção visual; o estado sem dados da captura não comprova banco vazio.

## P0 — acesso anônimo com capacidade de alteração

**Evidências:** `src/components/ProtectedRoute.tsx:4` e `:8` retornam os filhos sem checagem. `src/contexts/PermissionsContext.tsx:78–85` constrói perfil de acesso completo quando não há perfil carregado, inclusive sem usuário. `supabase/migrations/20260917180000_portal_open_access.sql:26` cria policy `FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)` em todas as tabelas públicas existentes. A mesma migration concede CRUD, execução de funções e privilégios padrão. `20260917190000_portal_open_monitoramento.sql:14` considera usuário sem sessão como ativo.

**Consequência:** se aplicadas, essas políticas autorizam acesso direto à API, independentemente do que o botão Risco/Compliance mostra. RLS habilitada não resolve uma política que permite tudo.

**Correção:** verificar migrations aplicadas; restaurar guards/login e falhar fechado quando o perfil não existir; inventariar policies e grants anteriores, corrigir inclusive privilégios padrão e funções `SECURITY DEFINER`; validar Storage. Não basta remover apenas a policy nova, pois há políticas legadas permissivas, como a leitura pública de `liquidez_monitoramento_risco` em `20260511120000_create_liquidez_monitoramento_risco.sql`.

**Aceite:** acesso sem sessão negado; Compliance consulta/exporta, mas não importa/altera/recalcula; sessão de Risco recebe apenas as ações autorizadas; tentativa pela API recebe a mesma restrição.

## P0 — funções com privilégio de serviço sem autenticação própria

**Evidências:** `supabase/config.toml` desativa `verify_jwt` em várias funções. Em `supabase/functions/rules-liquidity/index.ts:11`, o cliente usa service role; o handler `:86` recebe CNPJ/data e grava resultados sem checar usuário/papel. O importador `import-cvm-informe-mensal` e o motor `calculo-risco-liquidez` inspecionados também não fazem essa checagem.

**Consequência:** se publicadas dessa forma, rotinas podem ser acionadas fora do portal; a proteção das tabelas não basta para um cliente privilegiado. Desativar JWT, isoladamente, não prova vulnerabilidade de toda função: revisar cada handler e seus mecanismos de autorização. Aqui há caminhos concretos sem essa proteção.

**Correção/aceite:** autenticar e autorizar o chamador antes de ler/gravar com privilégio elevado; diferenciar usuário de job interno; validar identidade, método, payload e limites. Testar invocação anônima e perfil sem escrita. Referência: [Supabase — RLS e chaves de serviço](https://supabase.com/docs/guides/database/postgres/row-level-security).

## P1 — ausência de matriz pode produzir índice favorável

**Evidências:** `calculo-risco-liquidez/index.ts:454–469` devolve zero para probabilidades ausentes; `:1750–1762` não exige que a matriz exista; `:1823–1824` usa índice 100 quando o passivo calculado é zero.

**Reprodução lógica:** fundo aberto com posição, sem matriz correspondente e sem resgates informados → probabilidade zero → passivo zero → índice 100. Esse caminho pode parecer suficiente mesmo com insumo obrigatório ausente.

**Correção/aceite:** separar ausência de fonte de passivo comprovadamente zero; retornar estado indisponível/incompleto com motivo. Teste deve remover apenas a matriz e verificar que o status não fica “ok”.

## P1 — reprocessamento histórico usa informação posterior

**Evidências:** seleção da matriz em `calculo-risco-liquidez/index.ts:1750–1762` escolhe a maior `data_ref` sem corte pela referência da carteira. Fallback de despesas em `:1982–2043` pode usar média dos meses disponíveis, sem delimitar a janela histórica à data-base.

**Consequência:** calcular julho depois de importar agosto pode alterar julho sem mudança na posição. É necessário fixar matriz, configuração e fontes usadas no fechamento, além do corte temporal.

**Aceite:** inserir uma matriz/despesa futura não altera um fechamento anterior; revisão explícita gera nova versão e preserva a antiga.

## P1 — importação mensal do portal não alimenta diretamente a base FCC

**Evidências:** `src/components/CvmInformesPanel.tsx:10` chama `import-cvm-informe-mensal`, que grava `fund_monthly_cvm_filing` em `index.ts:134`. Já `calculo-risco-liquidez/index.ts:900` lê `fidc_informe_mensal_import`, alimentada por `import-fidc-informe-mensal`. Não foi encontrada função `calculate-liquidity-cvm` no diretório, embora conste do README/AGENTS.

**Consequência:** toast de sucesso da importação não comprova atualização do cálculo. Existem dois contratos, tabelas e importadores com nomes parecidos.

**Correção:** definir uma origem/staging e um adaptador explícito para o motor FCC, sem publicar duas verdades divergentes. Exibir contagem de fundos/competências realmente cobertos.

## P1 — cache de liquidez perde classe e pode ocultar falha de gravação

**Evidências:** `src/lib/liquidezMonitoramentoRiscoDb.ts:11` remove o ISIN da chave; `:125–155` escolhe uma linha por CNPJ e grava por CNPJ/data. Erros de persistência são avisos no console. `src/pages/liquidez/LiquidezRelatorios.tsx:660` dispara a gravação sem aguardá-la e mantém cópia em localStorage.

**Consequência:** um status agregado conservador não substitui a memória por classe; a tela pode mostrar resultado sem garantir que foi persistido para outra sessão. Ausência de tabela pode ser silenciada.

**Correção/aceite:** resultado oficial por identidade completa + referência + versão; persistência no backend e erro visível; fechamento ligado ao run. localStorage somente cache de apresentação.

## P1 — regra financeira repartida entre backend e frontend

**Evidências:** limites/status em `calculo-risco-liquidez`; recálculo de status em `LiquidezFundDetailContent.tsx:135` e `:569`; stress aplicado na tela em `:779–807`. `src/lib/liquidezStressChoque.ts` fixa 20% do PL mesmo que top 3 cotistas excedam esse valor.

**Consequência:** tela, exportação e enquadramento podem consultar resultados de caminhos diferentes. O desenho precisa preservar o comportamento FCC homologado, inclusive suas particularidades, sem vendê-lo como outra metodologia.

**Aceite:** mesmos inputs/versionamento produzem mesmos índices, status e stress em tela e exportações. Não alterar “20%” por outra regra sem decisão metodológica.

## P1 — a checagem TypeScript falha

Comando executado: `node node_modules/typescript/bin/tsc --noEmit --pretty false`. Retorno: exit code 1, com erros em vários módulos.

Exemplos verificáveis:

- `src/pages/liquidez/LiquidezPassivoFundos.tsx:878–879`: variável `cnpj_classe` não declarada, embora `cnpjCadastro` tenha sido calculado anteriormente. O callback pode lançar ReferenceError ao receber cadastro.
- `src/integrations/supabase/types.ts:87` e `:355`: duas declarações incompatíveis de `liquidez_monitoramento_risco` (inclusive `dt_posicao` vs `fundo_dtposicao`).
- `LiquidezFundDetailContent.tsx:616/:632`: builder Supabase tratado como Promise completa; erros adicionais de tipos e estado pendente.
- `src/pages/Ativos.tsx:1198`: `Loader2` não declarado.
- Erros também em enquadramento, relatórios, risco de mercado, crédito, rentabilidade e mapas.

`package.json` tem `build: vite build`; não inclui uma etapa de typecheck. A aplicação abrir no navegador não demonstra correção de tipos nem valida fluxos condicionais com dados. Não foi executado build de produção ou teste integrado do banco nesta revisão.

## P1 — log de importação pode indicar sucesso antes da gravação

**Evidência:** `import-cvm-informe-mensal/index.ts:123` insere `registry_sync_log` com status `ok` antes dos lotes de upsert; o catch final só devolve erro HTTP, sem marcar essa linha como falha.

**Consequência:** uma falha de lote pode deixar carga parcial e log de sucesso. Além disso, esse importador não cumpre a descrição de log uniforme em `ingest_runs`.

**Correção:** running → ok/error com id de execução, contagens, etapa e mensagem; promover os fatos apenas após validação da carga, usando staging/transação apropriada. Idempotência e retentativas devem preservar a competência anterior válida.

## P2 — documentação e navegação não correspondem ao fork

**Evidência:** README descreve três páginas e seis migrations. `src/App.tsx` expõe crédito, rentabilidade e muitas subrotas; `src/config/portalNav.ts` contém o menu efetivo, diferente de `NAV_ITEMS` em `src/lib/liquidity.ts`. As páginas e funções `LiquidezPage`/`calculate-liquidity-cvm` documentadas não existem no estado atual.

**Correção:** documento de arquitetura refletindo o código; inventário de dependências do enquadramento; menu dedicado a Liquidez/Enquadramento/Mercado com ferramentas auxiliares contextualizadas. Não remover código compartilhado em bloco.

## P2 — duas estruturas visuais competem

**Evidência:** `src/main.tsx` carrega design system, `frame-tailwind.css` e `index.css`; o último usa overrides globais com `!important`. As páginas FCC usam `components/ui`, enquanto AppShell usa o kit CVPAR. `Icon.jsx` depende de máscaras obtidas de CDN: sem acesso externo, ícones desaparecem, como no teste visual isolado.

**Correção:** primeiro migrar a tela mensal de Liquidez para componentes/tokens aprovados; depois adaptar as telas restantes. Usar ícones locais já disponíveis no projeto, persistir tema e mover alteração do DOM para efeito, tratar responsividade e estados de erro. Não adicionar outra biblioteca nem redesenhar a identidade.

## Validação restante para implementação

- Confirmar projeto Supabase e isolamento de dados do FCC sem expor credenciais.
- Inspecionar schema/migrations efetivamente aplicados e gerar tipos compatíveis.
- Subir banco isolado e exercitar importações representativas com falhas e duplicatas.
- Receber fontes originais e saídas de referência do FCC para homologar cálculos.
- Verificar valores do relatório CVPAR para 28 combinações fundo/mês e formalizar exceções.
- Validar fechamento/versionamento, exportação e acesso por perfil.

Nenhuma alteração de regra, permissão do banco ou aplicação em produção foi realizada nesta etapa.
