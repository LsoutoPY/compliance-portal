# Competências reais para o golden master L1

Esta pasta está reservada para **2–3 competências reais completas**, depois de revisão do Back Office e anonimização quando necessária. Ainda não há dados reais aqui; os testes atuais usam apenas `tests/fixtures/synthetic_*`.

Para cada competência, colocar em subpasta `AAAA-MM/`:

1. ZIP original do Informe Mensal FIDC CVM usado na importação, preservando bytes e nome de origem.
2. Carteira(s) Diária(s) CSV efetivamente enviada(s), com administrador/custodiante, layout e data-base identificados. Registrar explicitamente quando não houve carteira.
3. PDF final produzido pelo fluxo atual para cada fundo, sem regenerá-lo depois da captura.
4. Manifesto com CNPJ ou identificador anonimizado estável, competência, nomes dos arquivos, SHA-256, data/hora da importação, versão `cvpar_fidc_mensal@2026.2` e aprovação do Back Office.
5. JSON de resultado esperado capturado da execução original, incluindo as 74 linhas, valor, qualidade, origem e ressalva; divergências conhecidas devem ficar anotadas, sem correção.

Não copiar credenciais, dados pessoais ou arquivos confidenciais não anonimizados para o Git. Guardar originais restritos fora deste repositório e registrar no manifesto uma referência controlada quando a política de dados impedir versionar o arquivo. A inclusão de dados reais exigirá revisão da correspondência entrada → PDF final antes de integrar seus testes ao portão L1.
