Campo de texto/número. Todo valor monetário ou percentual usa `numeric`.

```jsx
<Input label="Razão de garantia mínima" value={val} onChange={set} numeric suffix="%" hint="Regulamento: 110%" />
<Input icon="search" placeholder="Buscar cedente, sacado ou CNPJ" size="sm" />
<Input label="CNPJ do cedente" error="CNPJ inválido" value={cnpj} onChange={set} />
```
