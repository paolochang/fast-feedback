// A session marker records the last Fast Feedback server to write this inbox.
// When static and proxy servers share an inbox, the last writer wins.

export function renderSession({ id, mode, version, url, started_at }) {
  return JSON.stringify({ id, mode, version, url, started_at });
}

export function parseSession(text) {
  let session;
  try {
    session = JSON.parse(text);
  } catch {
    return null;
  }
  if (!session || typeof session !== "object" || Array.isArray(session)) return null;
  if (!(typeof session.id === "string" && session.id
    && ["static", "proxy"].includes(session.mode)
    && typeof session.version === "string" && session.version
    && typeof session.url === "string" && session.url
    && typeof session.started_at === "string" && session.started_at)) return null;
  return { id: session.id, mode: session.mode, version: session.version, url: session.url, started_at: session.started_at };
}
