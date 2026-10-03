Contêiner padrão de painel: fundo `--surface-card`, borda `--border-subtle`, raio 8px, sombra `--shadow-sm`.

```jsx
<Card title="Curva de inadimplência" subtitle="Safras 2024–2026 · over90" actions={<IconButton icon="download" label="Exportar" size="sm" />}>
  <VintageChart series={series} />
</Card>
<Card title="Cedentes" padding={false}><DataTable columns={cols} rows={rows} /></Card>
```

Nunca aninhe card dentro de card; use régua (`--border-subtle`) para separar blocos internos.
