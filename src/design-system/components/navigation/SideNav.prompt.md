Barra lateral da plataforma. Agrupe itens por `section` ("Carteira", "Risco", "Governança").

```jsx
<SideNav activeId="dashboard" onSelect={go} items={[
  { id:"dashboard", label:"Visão geral", icon:"layout-dashboard", section:"Carteira" },
  { id:"credito", label:"Risco de crédito", icon:"shield-alert", section:"Risco", badge:3 }
]} />
```

No mobile não use: troque por barra inferior de 5 itens no máximo (ver UI kit).
