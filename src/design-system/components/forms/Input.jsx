import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Input({ label, value, onChange, placeholder, hint, error, icon, suffix, type = "text", numeric, size = "md", disabled, required, id, className = "", ...rest }) {
  const fid = id || "in-" + (label || placeholder || "campo").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <div className={["rcv-field", className].filter(Boolean).join(" ")}>
      {label ? <label className="rcv-field__label" htmlFor={fid}>{label}{required ? <span className="rcv-field__req">*</span> : null}</label> : null}
      <div className={["rcv-inputwrap", size === "sm" ? "rcv-inputwrap--sm" : "", error ? "rcv-inputwrap--error" : "", disabled ? "rcv-inputwrap--disabled" : ""].filter(Boolean).join(" ")}>
        {icon ? <Icon name={icon} size={16} color="var(--text-subtle)" /> : null}
        <input id={fid} className={["rcv-input", numeric ? "rcv-input--numeric" : ""].filter(Boolean).join(" ")} type={type} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} {...rest} />
        {suffix ? <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", flex: "none" }}>{suffix}</span> : null}
      </div>
      {error ? <span className="rcv-field__error">{error}</span> : hint ? <span className="rcv-field__hint">{hint}</span> : null}
    </div>
  );
}
