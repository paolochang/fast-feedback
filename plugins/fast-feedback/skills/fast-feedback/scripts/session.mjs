// A session marker records every Fast Feedback server that has served this inbox.

function validSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) return null;
  if (!(typeof session.id === "string" && session.id
    && ["static", "proxy"].includes(session.mode)
    && typeof session.version === "string" && session.version
    && typeof session.url === "string" && session.url
    && typeof session.started_at === "string" && session.started_at)) return null;
  return { id: session.id, mode: session.mode, version: session.version, url: session.url, started_at: session.started_at };
}

export function renderSessions(sessions) {
  return JSON.stringify({ sessions });
}

export function parseSessions(text) {
  let marker;
  try {
    marker = JSON.parse(text);
  } catch {
    return [];
  }
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return [];
  if (Object.hasOwn(marker, "sessions")) {
    if (!Array.isArray(marker.sessions)) return [];
    return marker.sessions.map(validSession).filter(Boolean);
  }
  const session = validSession(marker);
  return session ? [session] : [];
}
