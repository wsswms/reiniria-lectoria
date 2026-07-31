import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function passwordHash(password, salt) {
  return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

export class OwnerAuth {
  constructor({ password, sessionTtlMs = 60_000, now = () => Date.now() }) {
    this.salt = randomBytes(16);
    this.expectedPassword = passwordHash(password, this.salt);
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
    this.sessions = new Map();
  }

  verifyPassword(password) {
    const actual = passwordHash(password, this.salt);
    return timingSafeEqual(actual, this.expectedPassword);
  }

  login(password) {
    if (!this.verifyPassword(password)) return undefined;
    const token = randomBytes(24).toString("base64url");
    const csrf = randomBytes(18).toString("base64url");
    this.sessions.set(token, { csrf, expiresAt: this.now() + this.sessionTtlMs });
    return { token, csrf };
  }

  getSession(token) {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }
}
