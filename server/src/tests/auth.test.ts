import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../app.js';
import { AUTH_RATE_LIMIT } from '../auth/rateLimit.js';
import pool from '../db.js';
import { parseTrustProxy } from '../trustProxy.js';

const credentials = { email: 'fox@example.com', password: 'hunter2!!' };

// Signs up a user. Pass overrides to change the email or password.
const signUp = async (overrides = {}) => {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ ...credentials, ...overrides });
  return res;
};

describe('POST /api/auth/signup', () => {
  it('creates a user, returns a token, and sets an httpOnly cookie', async () => {
    const res = await signUp();

    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual({ id: expect.any(Number), email: 'fox@example.com' });

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('token=');
    expect(cookie).toContain('HttpOnly');
  });

  it('stores a bcrypt hash, never the plain password', async () => {
    await signUp();

    const result = await pool.query('SELECT password_hash FROM users WHERE email = $1', [
      credentials.email,
    ]);
    const { password_hash: hash } = result.rows[0];

    expect(hash).not.toBe(credentials.password);
    expect(hash).toMatch(/^\$2b\$/);
  });

  it('never returns the password hash', async () => {
    const res = await signUp();

    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('rejects an email that is already registered, ignoring case', async () => {
    await signUp();
    const res = await signUp({ email: 'FOX@Example.com' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Email already registered' });
  });

  it.each([
    ['a missing password', { password: undefined }],
    ['a password under 8 characters', { password: 'short' }],
    ['an email without @', { email: 'not-an-email' }],
    ['a password that is not a string', { password: 12345678 }],
  ])('rejects %s', async (_label, overrides) => {
    const res = await signUp(overrides);

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with the right password', async () => {
    await signUp();
    const res = await request(app).post('/api/auth/login').send(credentials);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('fox@example.com');
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    await signUp();

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ ...credentials, password: 'wrong-password' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Identical responses, so nobody can tell which emails have accounts.
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it.each([
    ['a missing email', { email: undefined }],
    ['a missing password', { password: undefined }],
    ['an empty password', { password: '' }],
    ['a password that is not a string', { password: 12345678 }],
  ])('rejects %s', async (_label, overrides) => {
    await signUp();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ ...credentials, ...overrides });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Email and password are required' });
  });
});

describe('rate limiting', () => {
  const wrongLogin = (email = credentials.email, ip?: string) => {
    const req = request(app).post('/api/auth/login');
    if (ip) req.set('X-Forwarded-For', ip);
    return req.send({ email, password: 'wrong-password' });
  };

  // Makes the limit's worth of failed attempts, all of which are still let through.
  const useUpAttempts = async (email = credentials.email) => {
    for (let attempt = 1; attempt <= AUTH_RATE_LIMIT; attempt++) {
      expect((await wrongLogin(email)).status).toBe(401);
    }
  };

  it(`blocks login after ${AUTH_RATE_LIMIT} failed attempts, with a JSON 429`, async () => {
    await signUp();
    await useUpAttempts();

    const blocked = await wrongLogin();

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many attempts. Try again in 15 minutes' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('blocks even the right password once the limit is reached', async () => {
    await signUp();
    await useUpAttempts();

    const res = await request(app).post('/api/auth/login').send(credentials);

    expect(res.status).toBe(429);
  });

  it('counts an email the same however it is capitalised', async () => {
    await signUp();
    await useUpAttempts();

    expect((await wrongLogin('FOX@Example.com')).status).toBe(429);
  });

  it('keeps a separate count for each email', async () => {
    await signUp();
    await useUpAttempts();

    expect((await wrongLogin('someone-else@example.com')).status).toBe(401);
  });

  it('does not count successful logins', async () => {
    await signUp();

    for (let attempt = 1; attempt <= AUTH_RATE_LIMIT + 2; attempt++) {
      const res = await request(app).post('/api/auth/login').send(credentials);
      expect(res.status).toBe(200);
    }
  });

  it('ignores X-Forwarded-For when no proxy is trusted, so the IP cannot be faked', async () => {
    await signUp();
    await useUpAttempts();

    expect((await wrongLogin(credentials.email, '203.0.113.7')).status).toBe(429);
  });

  it(`blocks signup after ${AUTH_RATE_LIMIT} attempts from one address`, async () => {
    for (let attempt = 1; attempt <= AUTH_RATE_LIMIT; attempt++) {
      const res = await signUp({ email: `fox${attempt}@example.com` });
      expect(res.status).toBe(201);
    }

    const blocked = await signUp({ email: 'one-too-many@example.com' });

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many attempts. Try again in 15 minutes' });
  });
});

describe('parseTrustProxy', () => {
  it.each([
    [undefined, 'production', 1],
    [undefined, 'development', false],
    ['', 'production', 1],
    ['2', 'production', 2],
    ['0', 'production', 0],
    ['true', undefined, true],
    ['false', 'production', false],
    [' 10.0.0.0/8, 127.0.0.1 ', undefined, '10.0.0.0/8, 127.0.0.1'],
  ])('reads %j (NODE_ENV %s) as %j', (value, nodeEnv, expected) => {
    expect(parseTrustProxy(value, nodeEnv)).toBe(expected);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the user when the cookie is sent (dashboard)', async () => {
    const agent = request.agent(app); // an agent remembers cookies, like a browser
    await agent.post('/api/auth/signup').send(credentials);

    const res = await agent.get('/api/auth/me');

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('fox@example.com');
  });

  it('returns the user when a Bearer token is sent (extension)', async () => {
    const { body } = await signUp();

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('fox@example.com');
  });

  it('rejects a request with no token', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
  });

  it('rejects a made-up token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(401);
  });

  it('rejects a token that has expired', async () => {
    const { body } = await signUp();
    // Signed with the real (test) secret, but already past its expiry time.
    const expired = jwt.sign({ userId: body.user.id }, 'test-only-secret', { expiresIn: -60 });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  it('rejects a token signed with a different secret (a forgery)', async () => {
    const { body } = await signUp();
    const forged = jwt.sign({ userId: body.user.id }, 'not-our-secret', { expiresIn: '7d' });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired token' });
  });

  it('rejects a valid token whose account no longer exists', async () => {
    const { body } = await signUp();
    await pool.query('DELETE FROM users WHERE id = $1', [body.user.id]);

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.token}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Not logged in' });
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie, so /me stops working', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send(credentials);

    const logout = await agent.post('/api/auth/logout');
    const me = await agent.get('/api/auth/me');

    expect(logout.status).toBe(200);
    expect(me.status).toBe(401);
  });
});
