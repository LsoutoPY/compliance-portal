import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Checkbox({ label, description, checked, indeterminate, onChange, disabled, className = "" }) {
  const ref = React.useRef(null);
  React.useEffect(function () { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <label className={["rcv-check", className].filter(Boolean).join(" ")} style={disabled ? { opacity: .5, cursor: "not-allowed" } : undefined}>
      <input ref={ref} type="checkbox" checked={!!checked} onChange={onChange} disabled={disabled} />
      <span className="rcv-check__box">{checked ? <Icon name="check" size={11} color="var(--text-on-brand)" /> : indeterminate ? <Icon name="minus" size={11} color="var(--text-on-brand)" /> : null}</span>
      <span>
        <span className="rcv-check__label">{label}</span>
        {description ? <span className="rcv-check__desc" style={{ display: "block" }}>{description}</span> : null}
      </span>
    </label>
  );
}
