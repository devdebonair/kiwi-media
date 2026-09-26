"use client";
import { useEffect, useState } from "react";

// Renders a plugin or VPN settings schema. Saved secrets are never sent to the browser:
// their inputs stay blank, and leaving them blank keeps the stored value.
export function ConfigFields({ fields, values, secrets = {}, onChange, cleared = [], onClear, api, disabled }) {
  return <div className="config-fields">
    {fields.map(field => <ConfigField key={field.key} field={field} value={values[field.key]} saved={secrets[field.key]} api={api} disabled={disabled}
      onChange={value => onChange({ ...values, [field.key]: value })} cleared={cleared.includes(field.key)}
      onClear={onClear && (checked => onClear(checked ? [...cleared, field.key] : cleared.filter(key => key !== field.key)))} />)}
  </div>;
}

function ConfigField({ field, value, saved, onChange, cleared, onClear, api, disabled }) {
  const id = `config-${field.key}`;
  const secret = field.type === "secret" || field.type === "secret-textarea";
  const placeholder = secret && saved ? cleared ? "Will be removed" : "Saved — leave blank to keep" : field.placeholder || "";
  const help = field.help && <small className="field-help">{field.help}</small>;
  if (field.type === "boolean") return <label className="config-toggle"><input type="checkbox" checked={Boolean(value ?? field.default)} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{field.label}{help}</span></label>;
  const input = field.type === "select" ? <SelectInput id={id} field={field} value={value ?? field.default ?? ""} onChange={onChange} api={api} disabled={disabled} />
    : field.type?.endsWith("textarea") ? <textarea id={id} rows={field.type === "secret-textarea" ? 7 : 4} value={value ?? ""} placeholder={placeholder} spellCheck={false} disabled={disabled} onChange={event => onChange(event.target.value)} />
    : <input id={id} type={field.type === "secret" ? "password" : field.type === "number" ? "number" : "text"} autoComplete={secret ? "new-password" : "off"} spellCheck={false}
      value={value ?? ""} placeholder={placeholder || (field.default != null ? String(field.default) : "")} disabled={disabled} onChange={event => onChange(event.target.value)} />;
  const clear = secret && saved && !field.required && onClear && <label className="config-toggle"><input type="checkbox" checked={cleared} disabled={disabled} onChange={event => onClear(event.target.checked)} /><span>Remove saved {field.label.toLowerCase()}</span></label>;
  return <div className="config-field"><label htmlFor={id}>{field.label}{field.required && !saved && <span aria-hidden="true"> *</span>}</label>{input}{help}{clear}</div>;
}

function SelectInput({ id, field, value, onChange, api, disabled }) {
  const [options, setOptions] = useState(field.options || null), [error, setError] = useState("");
  useEffect(() => {
    if (!field.optionsUrl) return;
    api(field.optionsUrl).then(setOptions).catch(failure => setError(failure.message));
  }, [field.optionsUrl]);
  if (error) return <><input id={id} value={value} onChange={event => onChange(event.target.value)} disabled={disabled} /><small className="field-error">Could not load choices: {error}. Enter the value directly.</small></>;
  return <select id={id} value={value} disabled={disabled || !options} onChange={event => onChange(event.target.value)}>
    {!options ? <option>Loading…</option> : <><option value="">Choose…</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</>}
  </select>;
}
