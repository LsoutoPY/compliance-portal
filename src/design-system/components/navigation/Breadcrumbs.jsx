import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Breadcrumbs({ items = [], onNavigate, className = "" }) {
  return (
    <nav className={["rcv-crumbs", className].filter(Boolean).join(" ")} aria-label="Trilha">
      {items.map(function (it, i) {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={it.label}>
            {last ? <span style={{ color: "var(--text-body)", fontWeight: "var(--weight-medium)" }} aria-current="page">{it.label}</span>
              : <button type="button" onClick={function () { if (onNavigate) onNavigate(it.id || it.label); }}>{it.label}</button>}
            {last ? null : <Icon name="chevron-right" size={13} color="var(--text-subtle)" />}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
