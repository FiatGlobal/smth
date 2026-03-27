import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const redis = Redis.fromEnv();

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export default async function handler(req) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { pixels, w, h } = body;

      if (!pixels || !Array.isArray(pixels)) {
        return new Response(JSON.stringify({ error: 'invalid' }), { status: 400, headers: HEADERS });
      }

      const id = Date.now().toString();
      const entry = { id, pixels, w: w || 30, h: h || 30, ts: Date.now() };

      await redis.set(`px:${id}`, JSON.stringify(entry));
      await redis.zadd('px:list', { score: Date.now(), member: id });
      await redis.zremrangebyrank('px:list', 0, -201);

      return new Response(JSON.stringify({ ok: true, id }), { headers: HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: HEADERS });
    }
  }

  if (req.method === 'GET') {
    try {
      const ids = await redis.zrange('px:list', 0, 99, { rev: true });
      if (!ids || ids.length === 0) {
        return new Response(JSON.stringify([]), { headers: HEADERS });
      }

      const items = await Promise.all(
        ids.map(id => redis.get(`px:${id}`))
      );

      const parsed = items
        .filter(Boolean)
        .map(item => typeof item === 'string' ? JSON.parse(item) : item);

      return new Response(JSON.stringify(parsed), {
        headers: { ...HEADERS, 'Cache-Control': 's-maxage=30' }
      });
    } catch (e) {
      return new Response(JSON.stringify([]), { headers: HEADERS });
    }
  }

  return new Response('method not allowed', { status: 405 });
}
