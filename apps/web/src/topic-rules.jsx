"use client";

import { useState } from "react";
import { X } from "@phosphor-icons/react";
import { AddTag } from "./add-tag.jsx";
import { TopicLabel } from "./topic-label.jsx";

// Tags listed here are standing rules: every item under the topic, now or later, carries them.
export function TopicRules({ topic, api, onChange }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const endpoint = `/api/v1/topics/${encodeURIComponent(topic.id)}/topics`;
  const remove = async tag => {
    setBusy(true); setError("");
    try { onChange((await api(`${endpoint}/${encodeURIComponent(tag.id)}`, { method: "DELETE" })).topics); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <div className="topic-rules">
    <p id={`topic-rules-${topic.id}`}>Items tagged {topic.name} also get</p>
    <div className="folder-tags chips" aria-labelledby={`topic-rules-${topic.id}`}>
      {topic.rules.map(tag => <button key={tag.id} disabled={busy} title={`Stop adding ${tag.name} to ${topic.name} items`} aria-label={`Stop adding ${tag.name} to ${topic.name} items`} onClick={() => remove(tag)}><TopicLabel topic={tag}/><X size={14}/></button>)}
      <AddTag asset={{ id: topic.id, title: topic.name, topics: [topic, ...topic.rules] }} api={api} endpoint={endpoint} label="Add auto-tag" onChange={onChange}/>
    </div>
    {error && <p className="tag-error" role="alert">{error}</p>}
  </div>;
}
