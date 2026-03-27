export const config = { runtime: 'edge' };

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

async function redisCmd(cmd) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${url}/${cmd.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.json();
}

async function verifyTelegramAuth(data) {
  const botToken = process.env.TG_BOT_TOKEN;
  if (!botToken) return false;
  const { hash, ...fields } = data;
  if (!hash) return false;
  const checkString = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const encoder = new TextEncoder();
  const keyData = await crypto.subtle.digest('SHA-256', encoder.encode(botToken));
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(checkString));
  const computedHash = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (computedHash !== hash) return false;
  const authDate = parseInt(fields.auth_date || '0');
  if (Date.now() / 1000 - authDate > 86400) return false;
  return true;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  try {
    const body = await req.json();
    const { pixelId, tgData } = body;
    if (!pixelId || !tgData) {
      return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400, headers: HEADERS });
    }

    const valid = await verifyTelegramAuth(tgData);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'invalid_auth' }), { status: 401, headers: HEADERS });
    }

    const userId = tgData.id.toString();
    const likeKey = `like:${pixelId}:${userId}`;
    const existing = await redisCmd(['GET', likeKey]);
    let count, liked;

    if (existing.result) {
      // Unlike
      await redisCmd(['DEL', likeKey]);
      const countRes = await redisCmd(['DECR', `likes:${pixelId}`]);
      count = Math.max(0, countRes.result || 0);
      liked = false;
      // Update or remove from liked sorted set
      if (count > 0) {
        await redisCmd(['ZADD', 'px:liked', count.toString(), pixelId]);
      } else {
        await redisCmd(['ZREM', 'px:liked', pixelId]);
      }
    } else {
      // Like
      await redisCmd(['SET', likeKey, '1']);
      await redisCmd(['EXPIRE', likeKey, '2592000']);
      const countRes = await redisCmd(['INCR', `likes:${pixelId}`]);
      count = countRes.result || 0;
      liked = true;
      // Add/update in liked sorted set
      await redisCmd(['ZADD', 'px:liked', count.toString(), pixelId]);
    }

    return new Response(JSON.stringify({ ok: true, liked, count }), { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: HEADERS });
  }
}
