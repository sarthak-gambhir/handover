import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { router } from './routes.js';
import { store } from './sessions.js';
import { cookieName } from './auth.js';
import { config } from './config.js';

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api', router);

let server: http.Server;
let port: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  store.sessions.clear();
  store.tokens.clear();
  store.totalBytesGlobal = 0;
});

function newOwnerSession() {
  const { session, ownerToken } = store.createSession();
  return { slug: session.slug, token: ownerToken, session };
}

function cookieHeader(slug: string, token: string): string {
  return `${cookieName(slug)}=${token}`;
}

describe('POST /api/sessions/:slug/files', () => {
  it('accepts a small upload, canonicalises the name, accounts the bytes', async () => {
    const { slug, token, session } = newOwnerSession();
    const res = await request(server)
      .post(`/api/sessions/${slug}/files`)
      .set('Cookie', cookieHeader(slug, token))
      .attach('file', Buffer.from('hello world'), 'My Doc.TXT');
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('my-doc.txt');
    expect(res.body.size).toBe(11);
    expect(session.bucket.size).toBe(1);
    expect(session.total_bytes).toBe(11);
  });

  it('401 without a cookie', async () => {
    const { slug } = newOwnerSession();
    const res = await request(server)
      .post(`/api/sessions/${slug}/files`)
      .attach('file', Buffer.from('x'), 'a.txt');
    expect(res.status).toBe(401);
  });

  it('507 when the reservation would exceed the per-session cap', async () => {
    const { slug, token, session } = newOwnerSession();
    // Pre-fill close to the cap so a small upload cannot be reserved.
    store.reserveBytes(session, config.maxSessionBytes - 4);
    const before = session.total_bytes;
    const res = await request(server)
      .post(`/api/sessions/${slug}/files`)
      .set('Cookie', cookieHeader(slug, token))
      .attach('file', Buffer.from('way bigger than four bytes'), 'big.txt');
    expect(res.status).toBe(507);
    // Failed reservation must not leak bytes.
    expect(session.total_bytes).toBe(before);
  });

  it('411 when Content-Length is absent (chunked upload)', async () => {
    const { slug, token } = newOwnerSession();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/sessions/${slug}/files`,
          method: 'POST',
          headers: {
            Cookie: cookieHeader(slug, token),
            'Content-Type': 'application/octet-stream',
            'Transfer-Encoding': 'chunked', // forces no Content-Length
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write('some-bytes');
      req.end();
    });
    expect(status).toBe(411);
  });
});

describe('DELETE /api/sessions/:slug/files/:id', () => {
  it('uploader can delete and the bytes are released', async () => {
    const { slug, token, session } = newOwnerSession();
    const up = await request(server)
      .post(`/api/sessions/${slug}/files`)
      .set('Cookie', cookieHeader(slug, token))
      .attach('file', Buffer.from('1234567890'), 'a.txt');
    expect(session.total_bytes).toBe(10);
    const id = up.body.id;
    const del = await request(server)
      .delete(`/api/sessions/${slug}/files/${id}`)
      .set('Cookie', cookieHeader(slug, token));
    expect(del.status).toBe(204);
    expect(session.bucket.size).toBe(0);
    expect(session.total_bytes).toBe(0);
  });

  it('403 when a non-uploader tries to delete', async () => {
    const { slug, token, session } = newOwnerSession();
    const up = await request(server)
      .post(`/api/sessions/${slug}/files`)
      .set('Cookie', cookieHeader(slug, token))
      .attach('file', Buffer.from('abc'), 'a.txt');
    const other = store.admitKnocker(
      session,
      store.addKnocker(session, 'Other').knocker.knock_id,
    )!;
    const del = await request(server)
      .delete(`/api/sessions/${slug}/files/${up.body.id}`)
      .set('Cookie', cookieHeader(slug, other.session_token));
    expect(del.status).toBe(403);
    expect(session.bucket.size).toBe(1);
  });
});

describe('GET /api/sessions/:slug/files/:id', () => {
  it('streams with a canonical Content-Disposition filename', async () => {
    const { slug, token } = newOwnerSession();
    const up = await request(server)
      .post(`/api/sessions/${slug}/files`)
      .set('Cookie', cookieHeader(slug, token))
      .attach('file', Buffer.from('payload'), 'Weird Name!.BIN');
    const res = await request(server)
      .get(`/api/sessions/${slug}/files/${up.body.id}`)
      .set('Cookie', cookieHeader(slug, token));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="weird-name.bin"');
  });
});

describe('POST /api/sessions/:slug/knock', () => {
  it('rejects an invalid display name (bidi override) with 400', async () => {
    const { slug } = newOwnerSession();
    const res = await request(server)
      .post(`/api/sessions/${slug}/knock`)
      .send({ display_name: 'Alice\u202EEvil' });
    expect(res.status).toBe(400);
  });

  it('423 when knocking is paused', async () => {
    const { slug, session } = newOwnerSession();
    session.knocking_paused = true;
    const res = await request(server)
      .post(`/api/sessions/${slug}/knock`)
      .send({ display_name: 'Alice' });
    expect(res.status).toBe(423);
  });
});
