"use client";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";

// Dark dialog shell: Escape or a backdrop click closes it, and focus returns to the opener.
// Rendered into <body> because the blurred topbar would otherwise contain its fixed backdrop.
export function Modal({ title, close, className = "", children }) {
  const titleId = useId(), ref = useRef(null);
  useEffect(() => {
    const node = ref.current, previous = document.activeElement;
    if (!node.contains(document.activeElement)) node.querySelector("[autofocus], input, textarea, select, button")?.focus();
    const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
    node.addEventListener("keydown", onKey);
    return () => { node.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, []);
  return createPortal(<div className="dialog-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
    <div ref={ref} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" onClick={close} aria-label="Close"><X /></button></div>
      {children}
    </div>
  </div>, document.body);
}
