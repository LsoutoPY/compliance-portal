import React from "react";

export function Switch({ label, description, checked, onChange, disabled, className = "" }) {
  return (
    <label className={["rcv-switch", className].filter(Boolean).join(" ")} style={disabled ? { opacity: .5, cursor: "not-allowed" } : undefined}>
      <input type="checkbox" role="switch" checked={!!checked} onChange={onChange} disabled={disabled} />
      <span className="rcv-switch__track"><span className="rcv-switch__knob" /></span>
      {label ? (
        <span>
          <span className="rcv-check__label">{label}</span>
          {description ? <span className="rcv-check__desc" style={{ display: "block" }}>{description}</span> : null}
        </span>
      ) : null}
    </label>
  );
}
