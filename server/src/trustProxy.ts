// Works out Express's 'trust proxy' setting, which decides what req.ip is.
// When deployed, requests reach us through the host's proxy, so the connection always comes
// from the proxy's address and the visitor's real one is in the X-Forwarded-For header.
// Trusting that header is only safe for proxies we know about: anyone can send it, so
// trusting too much would let a visitor pick their own IP and dodge the login rate limit.
export type TrustProxy = boolean | number | string;

// TRUST_PROXY can be:
//   a number: how many proxies sit in front of the server ("1" on Render)
//   "true" or "false"
//   addresses or subnets, comma-separated ("10.0.0.0/8, 127.0.0.1"), as Express accepts them
// When it isn't set: 1 in production (one proxy in front, as on Render), otherwise false,
// because nothing sits in front of a local server.
export const parseTrustProxy = (
  value: string | undefined,
  nodeEnv: string | undefined,
): TrustProxy => {
  const trimmed = value?.trim();
  if (!trimmed) return nodeEnv === 'production' ? 1 : false;

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
};
