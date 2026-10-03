import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Select({ label, value, onChange, options = [], placeholder, hint, error, size = "md", disabled, id, className = "" }) {
  const fid = id || "sel-" + (label || "campo").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <div className={["rcv-field", className].filter(Boolean).join(" ")}>
      {label ? <label className="rcv-field__label" htmlFor={fid}>{label}</label> : null}
      <div className={["rcv-inputwrap", size === "sm" ? "rcv-inputwrap--sm" : "", error ? "rcv-inputwrap--error" : "", disabled ? "rcv-inputwrap--disabled" : ""].filter(Boolean).join(" ")}>
        <select id={fid} className="rcv-select" value={value} onChange={onChange} disabled={disabled}>
          {placeholder ? <option value="">{placeholder}</option> : null}
          {options.map(function (o) { return <option key={o.value} value={o.value}>{o.label}</option>; })}
        </select>
        <Icon name="chevron-down" size={15} color="var(--text-muted)" />
      </div>
      {error ? <span className="rcv-field__error">{error}</span> : hint ? <span className="rcv-field__hint">{hint}</span> : null}
    </div>
  );
}
