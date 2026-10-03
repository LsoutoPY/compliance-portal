import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Tabs({ tabs = [], activeId, onChange, className = "", ...rest }) {
  return (
    <div className={["rcv-tabs", className].filter(Boolean).join(" ")} role="tablist" {...rest}>
      {tabs.map(function (t) {
        return (
          <button key={t.id} type="button" role="tab" aria-selected={activeId === t.id} className="rcv-tab" onClick={function () { if (onChange) onChange(t.id); }}>
            {t.icon ? <Icon name={t.icon} size={16} /> : null}
            {t.label}
            {t.count != null ? <span className="rcv-tab__count">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
