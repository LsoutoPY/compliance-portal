// Referência interativa de planejamento. Sem conexão ao Supabase ou execução de regras.
// A tela de produção será implementada em AppShell; esta referência não cria rota de módulo.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '../../src/design-system/components/core/Button.jsx';
import { Card } from '../../src/design-system/components/core/Card.jsx';
import { Badge } from '../../src/design-system/components/core/Badge.jsx';
import { Select } from '../../src/design-system/components/forms/Select.jsx';
import { Tabs } from '../../src/design-system/components/navigation/Tabs.jsx';
import { SideNav } from '../../src/design-system/components/navigation/SideNav.jsx';
import '../../src/design-system/styles.css';
import './liquidez_proposta.css';
import data from './liquidez_proposta_data.json';

const brl = v => v == null ? 'Indisponível' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
const pct = v => v == null ? 'Indisponível' : v.toLocaleString('pt-BR', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: v!==0 && Math.abs(v)<0.0001 ? 4 : 2 });
const num = v => v == null ? 'Indisponível' : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const funds = [...new Set(data.preview.map(r => r.fund))];
const months = [...new Map(data.preview.map(r => [r.month, r.sheet])).entries()];
const buckets = ['≤ 5d','6–30d','31–60d','61–90d','91–120d','121–180d','181–240d','241–300d','301–365d','> 365d'];
const ages = ['Até 5 dias','6–30 dias','31–60 dias','61–90 dias','91–120 dias','> 120 dias'];
const colors = ['var(--series-1)','var(--series-2)','var(--series-3)','var(--series-4)','var(--series-5)','var(--series-6)'];
const sections = [[5,'Despesas mensais'],[13,'Movimentações'],[18,'Carteira e alocação'],[41,'Inadimplência e PDD'],[66,'Previsão de liquidação'],[79,'Concentração de cedentes'],[85,'Concentração de sacados'],[91,'Recompras'],[101,'Subordinação']];

function Value({ row, r }) {
  const v = row.values[r];
  return data.units[r] === 'fração (%)' ? pct(v) : data.units[r] === 'R$' ? brl(v) : `${num(v)} ${data.units[r]}`;
}
function Table({ row, rows }) {
  return <div className="table-scroll"><table className="rcv-table rcv-table--dense"><thead><tr><th scope="col">Indicador</th><th scope="col" className="num">Valor</th><th scope="col">Célula</th></tr></thead><tbody>{rows.map(r=><tr key={r}><th scope="row">{data.labels[r]}</th><td className="num"><Value row={row} r={r}/></td><td className="source-cell">{row.column}{r}</td></tr>)}</tbody></table></div>;
}
function Concentration({ row, start }) {
  const scale = Math.max(1, ...[0,1,2,3].map(i=>row.values[start+i]));
  return <>{[1,5,10,15].map((top,i)=><div className="conc-row" key={top}><div className="conc-row__label">Top {top}</div><div className="rcv-meter"><div className="rcv-meter__track"><div className="rcv-meter__fill" style={{width:`${row.values[start+i]/scale*100}%`,background:'var(--surface-brand)'}}/></div></div><div className="conc-row__val">{pct(row.values[start+i])}</div></div>)}<p className="muted small">Base percentual a homologar. Não é concentração de cotistas.</p></>;
}
function Trend({ row }) {
  const series = data.preview.filter(r=>r.fund===row.fund && r.month<=row.month);
  const maximum = Math.max(...series.map(r=>Math.max(r.values[101],r.values[102]))) * 1.15;
  const x = i => 35 + i * 510 / Math.max(1,series.length-1);
  const y = v => 100-v/maximum*85;
  return <><svg className="trend-svg" viewBox="0 0 570 130" role="img" aria-label={`Subordinação de janeiro até ${row.sheet}, em percentual; linha contínua realizada e tracejada mínimo informado`}>
    {[0,maximum/2,maximum].map(v=><g key={v}><line x1="35" x2="550" y1={y(v)} y2={y(v)} stroke="var(--grid-line)"/><text x="0" y={y(v)}>{Math.round(v*100)}%</text></g>)}
    <polyline points={series.map((r,i)=>`${x(i)},${y(r.values[102])}`).join(' ')} fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeDasharray="4 3"/>
    <polyline points={series.map((r,i)=>`${x(i)},${y(r.values[101])}`).join(' ')} fill="none" stroke="var(--surface-brand)" strokeWidth="2.5"/>
    {series.map((r,i)=><g key={r.month}><circle cx={x(i)} cy={y(r.values[101])} r="3" fill="var(--surface-brand)"><title>{r.sheet}: {pct(r.values[101])}</title></circle><text x={x(i)} y="122" textAnchor="middle">{r.sheet.slice(0,3)}</text></g>)}
  </svg><p className="muted small">Linha contínua: índice informado · tracejada: mínimo da planilha · 2026</p></>;
}
function Overview({ row, onAudit }) {
  const v=row.values, ageTotal=[51,52,53,54,55,56].reduce((s,r)=>s+v[r],0);
  const maxBucket=Math.max(...buckets.map((_,i)=>v[67+i]));
  return <>
    <div className="kpi-grid">{[[18,'Patrimônio líquido'],[19,'Direitos creditórios'],[26,'Ativos de liquidez · RF'],[27,'Tesouraria · caixa']].map(([r,label])=><Card className="kpi" key={r}><div className="kpi__label">{label}</div><div className="kpi__value">{brl(v[r])}</div><div className="muted small">{row.sheet}/2026 · {row.column}{r}</div></Card>)}</div>
    <div className="row2">
      <Card title="Subordinação" subtitle="Índice e mínimo informados na planilha; vigência a homologar" actions={<Badge tone="neutral">Referência histórica</Badge>}>
        <div className="sub-readout"><strong>{pct(v[101])}</strong><span>Mínimo informado: {pct(v[102])}<br/>Folga: {num((v[101]-v[102])*100)} p.p.</span></div>
        <div className="rcv-meter"><div className="rcv-meter__track"><div className="rcv-meter__fill" style={{width:`${v[101]*100}%`,background:'var(--surface-brand)'}}/><div className="rcv-meter__mark" style={{left:`${v[102]*100}%`}}/></div></div>
        <Trend row={row}/>
      </Card>
      <Card title="Inadimplência e PDD" subtitle="Faixas abaixo representam a participação no total vencido">
        <div className="pair"><div><div className="kpi__label">PDD / PL</div><strong className="metric">{pct(v[43])}</strong></div><div><div className="kpi__label">Vencidos / DC</div><strong className="metric">{pct(v[45])}</strong></div></div>
        <div className="faixa-stack" role="img" aria-label={`Total de vencidos por faixas: ${brl(ageTotal)}`}>{ages.map((label,i)=>v[51+i]>0&&<div className="faixa-seg" key={label} style={{width:`${v[51+i]/ageTotal*100}%`,background:colors[i]}} title={`${label}: ${brl(v[51+i])}`}/>)}</div>
        <div className="faixa-legend">{ages.map((label,i)=><div key={label}><span className="dot" style={{background:colors[i]}}/>{label}<span className="num">{brl(v[51+i])}</span></div>)}</div>
        <Button variant="ghost" size="sm" onClick={onAudit}>Conferir bases e diferenças</Button>
      </Card>
    </div>
    <Card title="Previsão de liquidação dos direitos creditórios" subtitle="Valores da planilha em R$ por faixa. Convenção de dias e base do fluxo a homologar.">
      <div className="bucket-bar">{buckets.map((label,i)=><div className="bucket-col" key={label}><span className="bucket-col__value">{num(v[67+i]/1e6)} mi</span><div className="bucket-col__plot"><div className="bucket-col__bar" style={{height:`${maxBucket>0?v[67+i]/maxBucket*100:0}%`}} title={`${label}: ${brl(v[67+i])}`}/></div><span className="bucket-col__label">{label}</span></div>)}</div>
      <p className="muted small">Total previsto: {brl(v[66])} · Não representa, por si só, caixa disponível para resgate.</p>
    </Card>
    <div className="row2b"><Card title="Concentração de cedentes"><Concentration row={row} start={79}/></Card><Card title="Concentração de sacados"><Concentration row={row} start={85}/></Card></div>
    <div className="row2b"><Card title="Despesas mensais" padding={false}><Table row={row} rows={[5,6,7,8,9,10]}/></Card><Card title="Movimentações e recompra" padding={false}><Table row={row} rows={[13,14,15,93,94,95,96,97,98]}/></Card></div>
  </>;
}
function Audit({ row }) {
  const findings=data.findings.filter(f=>f.sheet===row.sheet&&f.fund===row.fund);
  return <>
    <Card title="Diferenças para conferir" subtitle={`${row.fund} · ${row.sheet}/2026 · verificação de valores gravados, sem recalcular o Excel`}>
      {findings.length?findings.map((f,i)=><article className="finding" key={i}><Badge tone="warning">Validar base</Badge><h3>{f.kind}</h3><p>{f.cells}: <strong className="num">{num(f.a)}</strong> versus <strong className="num">{num(f.b)}</strong>.</p><p className="muted">{f.kind.includes('Recompra')?'O segundo valor usa a expressão observada nas demais colunas: soma(93:95) / soma(93:96), em fração. Confirmar a regra do fundo.':f.kind.includes('Concentração')?'Valores em fração. Percentual sobre PL pode superar 100%; a base precisa ser confirmada.':'Confirmar se os valores têm a mesma população, unidade e data antes de classificá-los como erro.'}</p></article>):<p>As verificações numéricas executadas não localizaram divergências neste fundo/mês. As decisões metodológicas abaixo continuam pendentes.</p>}
    </Card>
    <Card title="Decisões comuns antes de automatizar"><ol className="decision-list"><li>Confirmar denominador das faixas: o texto diz PL, mas há fórmulas sobre o total vencido.</li><li>Confirmar se o volume de direitos creditórios já é líquido da PDD.</li><li>Documentar pesos e calendário dos prazos médios, taxas de cessão e composição da subordinação.</li><li>Receber os arquivos originais que geraram despesas, baixas, concentração e fluxos.</li></ol><p className="muted">Essas pendências de homologação são diferentes de um desenquadramento do fundo.</p></Card>
  </>;
}
function FCC() {
  return <Card title="Metodologia FCC" subtitle="Inventário do código encontrado; resultados de fundos não foram executados nesta referência">
    <table className="rcv-table"><thead><tr><th>Regra existente</th><th>Comportamento observado</th><th>Integração proposta</th></tr></thead><tbody>{[
      ['Ativo × passivo','Vértices em dias úteis e resgates solicitados','Preservar entradas e memória por classe'],
      ['Limites','Hard ≤ 1; soft por prazo 1,20 / 1,10 / 1,05','Versionar parâmetros e unificar tela/servidor'],
      ['Fundos fechados','Cobertura de despesas; patamares 3 e 7 meses','Separar de subordinação CVPAR'],
      ['Stress','20% do PL no frontend; top 3 como contexto','Homologar regra e calcular no servidor'],
      ['Matriz ANBIMA','Motor usa a mais recente disponível','Fixar versão válida na data-base'],
    ].map(([a,b,c])=><tr key={a}><th scope="row">{a}</th><td>{b}</td><td>{c}</td></tr>)}</tbody></table>
    <p className="muted">Trocar metodologia para consulta não altera a política oficial do fundo. A versão FCC deverá ser homologada com saídas do hub original.</p>
  </Card>;
}
function Proposal() {
  const [fund,setFund]=useState(funds[0]),[month,setMonth]=useState(7),[method,setMethod]=useState('cvpar'),[tab,setTab]=useState('resumo'),[theme,setTheme]=useState('light'),[module,setModule]=useState('liquidez');
  useEffect(()=>{document.documentElement.setAttribute('data-theme',theme);},[theme]);
  const row=data.preview.find(r=>r.fund===fund&&r.month===month);
  const currentRows=data.preview.filter(r=>r.month===month);
  return <div className="rcv-app proposal">
    <SideNav brand="Risco CVPAR" activeId={module} items={[{id:'liquidez',label:'Liquidez',section:'Risco',icon:'droplets'},{id:'mercado',label:'Mercado',section:'Risco',icon:'trending-up'},{id:'enquadramento',label:'Enquadramento',section:'Compliance',icon:'shield-check'}]} onSelect={setModule} footer="Referência de interface • Setembro/2026"/>
    <div className="proposal-shell">
      <header className="proposal-topbar"><div><span className="eyebrow">Portal de risco e compliance</span><h1>{module==='liquidez'?'Liquidez · relatório mensal':module==='mercado'?'Risco de mercado':'Enquadramento'}</h1></div><div className="toolbar-actions"><Badge tone="neutral">Estudo de interface</Badge><Button variant="secondary" size="sm" onClick={()=>setTheme(theme==='light'?'dark':'light')}>{theme==='light'?'Tema escuro':'Tema claro'}</Button><a className="rcv-btn rcv-btn--primary rcv-btn--sm" href="../PLANO_LIQUIDEZ_CVPAR.md" target="_blank" rel="noreferrer">Ler plano completo</a></div></header>
      <main className="proposal-main rcv-scroll">
        <div className="reference-note">Dados históricos da planilha anexa · sem conexão ao banco · prévia para discutir o fluxo, não relatório oficial.</div>
        {module!=='liquidez'?<Card title={module==='enquadramento'?'Preservar o módulo completo do FCC':'Manter o módulo de mercado existente'}><p>{module==='enquadramento'?'Reutilizar regras, monitoramento e relatórios. A integração precisa validar as dependências, as permissões e a identidade dos fundos/classes no projeto isolado.':'Aplicar o mesmo AppShell, filtros, tipografia e estados. O foco desta etapa é automatizar a liquidez mensal.'}</p><Button onClick={()=>setModule('liquidez')}>Voltar à liquidez mensal</Button></Card>:<>
          <section className="context-bar" aria-label="Filtros do relatório"><Select id="fund" label="Fundo" value={fund} options={funds.map(f=>({value:f,label:f}))} onChange={e=>setFund(e.target.value)}/><Select id="month" label="Competência" value={String(month)} options={months.map(([m,s])=>({value:String(m),label:`${s.charAt(0)+s.slice(1).toLowerCase()}/2026`}))} onChange={e=>setMonth(Number(e.target.value))}/><Select id="method" label="Metodologia em consulta" value={method} options={[{value:'cvpar',label:'CVPAR mensal · proposta v1'},{value:'fcc',label:'FCC · regras existentes'}]} onChange={e=>setMethod(e.target.value)}/><div className="context-state"><Badge tone="warning">A homologar</Badge><span className="muted small">Fonte: planilha · {row.sheet}/2026</span></div></section>
          <Tabs activeId={tab} onChange={setTab} aria-label="Visões de liquidez" tabs={[{id:'resumo',label:'Resumo por fundo'},{id:'consolidado',label:'Consolidado · 4 fundos'},{id:'memoria',label:'Memória do relatório'},{id:'conferencia',label:'Conferência'},{id:'metodologia',label:'Configuração proposta'}]}/>
          {method==='fcc'?<FCC/>:tab==='resumo'?<Overview row={row} onAudit={()=>setTab('conferencia')}/>:tab==='conferencia'?<Audit row={row}/>:tab==='memoria'?<Card title="Todas as linhas do relatório" subtitle="Valores gravados no arquivo original. Fórmulas e dicionário completo estão no mapeamento." padding={false}><Table row={row} rows={Object.keys(data.labels).map(Number)}/></Card>:tab==='consolidado'?<Card title={`Consolidado · ${row.sheet}/2026`} subtitle="Quatro fundos nas mesmas colunas do relatório de Compliance" padding={false}><div className="table-scroll"><table className="rcv-table rcv-table--dense"><thead><tr><th>Indicador</th>{currentRows.map(r=><th key={r.fund} className="num">{r.fund}</th>)}</tr></thead><tbody>{Object.keys(data.labels).map(Number).map(r=><React.Fragment key={r}>{sections.some(([start])=>start===r)&&<tr className="table-section"><th colSpan={5}>{sections.find(([start])=>start===r)[1]}</th></tr>}<tr><th scope="row">{data.labels[r]}</th>{currentRows.map(row=><td key={row.fund} className="num"><Value row={row} r={r}/></td>)}</tr></React.Fragment>)}</tbody></table></div></Card>:<Card title="Configurar sem criar um editor de fórmulas" subtitle="Proposta funcional; nenhuma configuração é gravada nesta referência"><table className="rcv-table"><thead><tr><th>Configuração</th><th>Como funcionará</th></tr></thead><tbody>{[['Método por fundo/classe','FCC ou CVPAR mensal, com versão e vigência'],['Fontes por indicador','Preferência, alternativa permitida e data-base explícitas'],['Limites e bases','Parâmetros tipados e aprovados; PL/DC; DU/DC; composição da recompra'],['Fechamento','Conferência → versão imutável → PDF e Excel'],['Revisões','Mudança de fonte ou regra gera nova versão, sem apagar o histórico'],['Acesso','Risco prepara; Compliance consulta e exporta conforme perfil']].map(([a,b])=><tr key={a}><th scope="row">{a}</th><td>{b}</td></tr>)}</tbody></table></Card>}
          <footer className="proposal-footer"><div><strong>Fechamento mensal</strong><p className="muted small">A exportação oficial ficará disponível após integração das fontes e homologação das regras.</p></div><Button variant="secondary" onClick={()=>{setMethod('cvpar');setTab('conferencia');}}>Conferir pendências</Button><Button disabled title="Referência de planejamento: nenhum fechamento oficial foi produzido">Exportar relatório</Button></footer>
        </>}
      </main>
    </div>
  </div>;
}
createRoot(document.getElementById('root')).render(<Proposal/>);
