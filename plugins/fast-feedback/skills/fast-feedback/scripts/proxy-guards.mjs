function normalizeHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;

  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function parseAuthority(value) {
  const authority = String(value || "").trim();
  if (!authority) return null;
  try {
    const url = new URL(authority.includes("://") ? authority : "http://" + authority);
    if (url.protocol !== "http:" || url.username || url.password) return null;
    return { hostname: normalizeHostname(url.hostname), port: Number(url.port || 80) };
  } catch {
    return null;
  }
}

export function isOwnProxyOrigin(headers, port) {
  const expectedPort = Number(port);
  const host = parseAuthority(headers.host);
  const origin = parseAuthority(headers.origin);
  const isProxyHost = (value) => value === "localhost" || value === "127.0.0.1";
  return Number.isInteger(expectedPort)
    && isProxyHost(host?.hostname)
    && isProxyHost(origin?.hostname)
    && host.port === expectedPort
    && origin.port === expectedPort;
}
