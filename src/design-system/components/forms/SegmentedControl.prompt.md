Alterna a janela de análise ou o modo de visualização — 2 a 4 opções curtas, sempre visíveis.

```jsx
<SegmentedControl value={janela} onChange={setJanela} options={[{value:"30",label:"30d"},{value:"90",label:"90d"},{value:"12m",label:"12m"}]} />
```

Acima de 4 opções use `Tabs` (navegação) ou `Select` (filtro).
