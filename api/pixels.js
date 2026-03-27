export const config = { runtime: 'edge' };

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

async function redis(cmd) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${url}/${cmd.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.json();
}

function getIP(req) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export default async function handler(req) {
  if (req.method === 'POST') {
    try {
      const ip = getIP(req);
      const rateKey = `rate:${ip}`;

      // Check rate limit — max 2 per hour
      const countRes = await redis(['GET', rateKey]);
      const count = parseInt(countRes.result || '0');
      if (count >= 2) {
        return new Response(JSON.stringify({ error: 'rate_limit', message: 'max 2 artworks per hour' }), { status: 429, headers: HEADERS });
      }

      const body = await req.json();
      const { pixels, w, h } = body;
      if (!pixels || !Array.isArray(pixels)) {
        return new Response(JSON.stringify({ error: 'invalid' }), { status: 400, headers: HEADERS });
      }

      const id = Date.now().toString();
      const entry = JSON.stringify({ id, pixels, w: w || 30, h: h || 30, ts: Date.now() });
      await redis(['SET', `px:${id}`, entry]);
      await redis(['ZADD', 'px:list', Date.now().toString(), id]);
      await redis(['ZREMRANGEBYRANK', 'px:list', '0', '-201']);

      // Increment rate limit counter, expire in 1 hour
      await redis(['INCR', rateKey]);
      await redis(['EXPIRE', rateKey, '3600']);

      return new Response(JSON.stringify({ ok: true, id }), { headers: HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: HEADERS });
    }
  }

  if (req.method === 'GET') {
    try {
      const idsRes = await redis(['ZRANGE', 'px:list', '0', '99', 'REV']);
      const ids = idsRes.result;
      if (!ids || ids.length === 0) {
        return new Response(JSON.stringify([]), { headers: HEADERS });
      }
      const items = await Promise.all(
        ids.map(id => redis(['GET', `px:${id}`]).then(r => r.result))
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
