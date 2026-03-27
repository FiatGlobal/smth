export const config = { runtime: 'edge' };

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const ALLOWED_COLORS = new Set([
  '#f0f0f0','#c8c8c8','#888888','#444444','#111111',
  '#e05252','#e07a52','#e0c252','#52c25e','#5290e0','#9452e0','#e052b8',
  '#52d4e0','#a0d452','#e0a052','#5e3a2a', null
]);

async function redis(cmd) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${url}/${cmd.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.json();
}

async function redisMGet(keys) {
  if (!keys.length) return [];
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${url}/mget/${keys.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.result || [];
}

function getIP(req) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

function validatePixels(pixels) {
  if (!Array.isArray(pixels)) return false;
  if (pixels.length !== 900) return false;
  for (const p of pixels) {
    if (p !== null && !ALLOWED_COLORS.has(p)) return false;
  }
  return true;
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

export default async function handler(req) {
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > 50000) {
    return new Response(JSON.stringify({ error: 'payload_too_large' }), { status: 413, headers: HEADERS });
  }

  if (req.method === 'POST') {
    try {
      const ip = getIP(req);
      const rateKey = `rate:${ip}`;
      const cooldownKey = `cooldown:${ip}`;

      // Check cooldown — 60 seconds between posts
      const cooldownRes = await redis(['GET', cooldownKey]);
      if (cooldownRes.result) {
        return new Response(JSON.stringify({ error: 'cooldown', message: 'wait a minute between posts' }), { status: 429, headers: HEADERS });
      }

      // Check hourly limit — max 2 per hour
      const countRes = await redis(['GET', rateKey]);
      const count = parseInt(countRes.result || '0');
      if (count >= 2) {
        return new Response(JSON.stringify({ error: 'rate_limit', message: 'max 2 artworks per hour' }), { status: 429, headers: HEADERS });
      }

      let body;
      try { body = await req.json(); }
      catch { return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: HEADERS }); }

      const { pixels } = body;
      if (!validatePixels(pixels)) {
        return new Response(JSON.stringify({ error: 'invalid_pixels' }), { status: 400, headers: HEADERS });
      }

      const id = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const entry = JSON.stringify({ id, pixels, w: 30, h: 30, ts: Date.now() });

      await redis(['SET', `px:${id}`, entry]);
      await redis(['ZADD', 'px:list', Date.now().toString(), id]);

      // Clean up old arts
      const oldIds = await redis(['ZRANGE', 'px:list', '0', '-201']);
      if (oldIds.result && oldIds.result.length > 0) {
        for (const oldId of oldIds.result) {
          await redis(['DEL', `px:${oldId}`]);
          await redis(['DEL', `votes:${oldId}`]);
          await redis(['DEL', `likes:${oldId}`]);
          await redis(['ZREM', 'px:liked', oldId]);
        }
        await redis(['ZREMRANGEBYRANK', 'px:list', '0', `-${oldIds.result.length + 1}`]);
      }

      // Set cooldown (60s) and increment hourly counter
      await redis(['SET', cooldownKey, '1']);
      await redis(['EXPIRE', cooldownKey, '60']);
      await redis(['INCR', rateKey]);
      await redis(['EXPIRE', rateKey, '3600']);

      return new Response(JSON.stringify({ ok: true, id }), { headers: HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers: HEADERS });
    }
  }

  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const type = url.searchParams.get('type') || 'new';

      if (type === 'liked') {
        const idsRes = await redis(['ZRANGE', 'px:liked', '0', '49', 'REV']);
        const ids = (idsRes.result || []).map(sanitizeId);
        if (!ids.length) return new Response(JSON.stringify([]), { headers: HEADERS });
        const values = await redisMGet(ids.map(id => `px:${id}`));
        const items = values.filter(Boolean).map(v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } }).filter(Boolean);
        const likeCounts = await redisMGet(items.map(i => `likes:${i.id}`));
        const withLikes = items.map((item, i) => ({ ...item, likes: parseInt(likeCounts[i] || '0') })).filter(i => i.likes > 0);
        return new Response(JSON.stringify(withLikes), { headers: { ...HEADERS, 'Cache-Control': 's-maxage=30' } });
      }

      const idsRes = await redis(['ZRANGE', 'px:list', '0', '99', 'REV']);
      const ids = (idsRes.result || []).map(sanitizeId);
      if (!ids.length) return new Response(JSON.stringify([]), { headers: HEADERS });
      const values = await redisMGet(ids.map(id => `px:${id}`));
      const items = values.filter(Boolean).map(v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } }).filter(Boolean);
      return new Response(JSON.stringify(items), { headers: { ...HEADERS, 'Cache-Control': 's-maxage=30' } });
    } catch (e) {
      return new Response(JSON.stringify([]), { headers: HEADERS });
    }
  }

  return new Response('method not allowed', { status: 405 });
}
