Seletor nativo com moldura do sistema — use para listas fechadas (fundo, período, cenário).

```jsx
<Select label="Fundo" value={fundo} onChange={setFundo} options={[{value:"cvpar-cred",label:"CVPAR Crédito Estruturado FIDC"}]} />
<Select size="sm" value={periodo} onChange={setPeriodo} options={periodos} />
```

Acima de ~8 opções com busca, prefira um campo `Input icon="search"` com lista filtrada.
