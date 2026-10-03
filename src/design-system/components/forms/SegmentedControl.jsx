import React from "react";
import { Icon } from "../core/Icon.jsx";

export function SegmentedControl({ options = [], value, onChange, size = "md", className = "", ...rest }) {
  return (
    <div className={["rcv-seg", size === "lg" ? "rcv-seg--lg" : "", className].filter(Boolean).join(" ")} role="tablist" {...rest}>
      {options.map(function (o) {
        return (
          <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className="rcv-seg__item" onClick={function () { if (onChange) onChange(o.value); }}>
            {o.icon ? <Icon name={o.icon} size={14} /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
