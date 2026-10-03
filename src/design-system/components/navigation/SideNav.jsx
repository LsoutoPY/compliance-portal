import React from "react";
import { Icon } from "../core/Icon.jsx";

export function SideNav({ items = [], activeId, onSelect, collapsed, brand = "RISCO CVPAR", footer, className = "" }) {
  let lastSection = null;
  return (
    <nav className={["rcv-nav", collapsed ? "rcv-nav--collapsed" : "", className].filter(Boolean).join(" ")} aria-label="Navegação principal">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", height: "var(--layout-topbar)", padding: "0 var(--space-4)", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <span style={{ flex: "none", width: 26, height: 26, borderRadius: "var(--radius-xs)", background: "var(--teal-200)", color: "var(--teal-800)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, letterSpacing: "-.04em" }}>RC</span>
        {collapsed ? null : <span style={{ fontSize: "var(--text-xs)", fontWeight: 600, letterSpacing: "var(--tracking-label)", textTransform: "uppercase", color: "#fff", whiteSpace: "nowrap" }}>{brand}</span>}
      </div>
      <div className="rcv-scroll" style={{ flex: 1, padding: "var(--space-2) var(--space-3) var(--space-5)" }}>
        {items.map(function (it) {
          const head = it.section && it.section !== lastSection ? it.section : null;
          lastSection = it.section || lastSection;
          return (
            <React.Fragment key={it.id}>
              {head && !collapsed ? <div className="rcv-nav__section">{head}</div> : null}
              <button type="button" className="rcv-nav__item" aria-current={activeId === it.id ? "page" : undefined} title={it.label} onClick={function () { if (onSelect) onSelect(it.id); }}>
                <Icon name={it.icon} size={18} />
                {collapsed ? null : <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>}
                {!collapsed && it.badge ? <span className="rcv-nav__badge">{it.badge}</span> : null}
              </button>
            </React.Fragment>
          );
        })}
      </div>
      {footer && !collapsed ? <div style={{ padding: "var(--space-4)", borderTop: "1px solid rgba(255,255,255,.08)", fontSize: "var(--text-xs)", color: "rgba(255,255,255,.6)" }}>{footer}</div> : null}
    </nav>
  );
}
