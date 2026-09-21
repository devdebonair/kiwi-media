export function TopicLabel({ topic }) {
  return <>
    {topic.avatar_url && <img className="chip-avatar" src={topic.avatar_url} alt="" width={22} height={22} onError={event => { event.currentTarget.hidden = true; }} />}
    {topic.name}
  </>;
}
