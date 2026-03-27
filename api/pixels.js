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

async function fetchByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const items = await Promise.all(
    ids.map(id => redis(['GET', `px:${id}`]).then(r => r.result))
  );
  return items.filter(Boolean).map(item => typeof item === 'string' ? JSON.parse(item) : item);
}

export default async function handler(req) {
  if (req.method === 'POST') {
    try {
      const ip = getIP(req);
      const rateKey = `rate:${ip}`;
      const countRes = await redis(['GET', rateKey]);
      const count = parseInt(countRes.result || '0');
      if (count >= 2) {
        return new Response(JSON.stringify({ error: 'rate_limit' }), { status: 429, headers: HEADERS });
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
      await redis(['INCR', rateKey]);
      await redis(['EXPIRE', rateKey, '3600']);

      return new Response(JSON.stringify({ ok: true, id }), { headers: HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: HEADERS });
    }
  }

  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const type = url.searchParams.get('type') || 'new';

      if (type === 'liked') {
        // Most liked — sorted by likes desc, min 1 like
        const ids = await redis(['ZRANGE', 'px:liked', '0', '49', 'REV']);
        const items = await fetchByIds(ids.result || []);
        // Attach like counts
        const withLikes = await Promise.all(items.map(async item => {
          const lr = await redis(['GET', `likes:${item.id}`]);
          return { ...item, likes: parseInt(lr.result || '0') };
        }));
        return new Response(JSON.stringify(withLikes.filter(i => i.likes > 0)), {
          headers: { ...HEADERS, 'Cache-Control': 's-maxage=30' }
        });
      }

      // New — sorted by time desc
      const ids = await redis(['ZRANGE', 'px:list', '0', '99', 'REV']);
      const items = await fetchByIds(ids.result || []);
      return new Response(JSON.stringify(items), {
        headers: { ...HEADERS, 'Cache-Control': 's-maxage=30' }
      });
    } catch (e) {
      return new Response(JSON.stringify([]), { headers: HEADERS });
    }
  }

  return new Response('method not allowed', { status: 405 });
}
