-- Versão nova: reconciliação do relatório CVPAR com as Tabs I, III, V–IX e X.4.
-- A 2026.1 permanece consultável para preservar as execuções anteriores.
insert into liquidity_monthly_methodologies (code, version, label, configuration)
values (
  'cvpar_fidc_mensal',
  '2026.2',
  'CVPAR FIDC mensal — mapeamento do relatório 2026.2',
  '{"creditExtraFields":["TAB_I2H_VL_COTA_FIDC","TAB_I2I_VL_COTA_FIDC_NP","TAB_I2C1_VL_DEBENTURE","TAB_I2C2_VL_CRI","TAB_I2C3_VL_NP_COMERC","TAB_I2C4_VL_LETRA_FINANC","TAB_I2C6_VL_OUTRO"],"grossUpPdd":true,"includeMezzanineInSubordination":true}'::jsonb
)
on conflict (code, version) do nothing;
