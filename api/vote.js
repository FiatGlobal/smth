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

function getThreshold(likes) {
  if (likes >= 10) return 12;
  if (likes >= 5) return 8;
  return 5;
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
    const voteKey = `vote:${pixelId}:${userId}`;

    const existing = await redisCmd(['GET', voteKey]);
    if (existing.result) {
      return new Response(JSON.stringify({ error: 'already_voted' }), { status: 409, headers: HEADERS });
    }

    await redisCmd(['SET', voteKey, '1']);
    await redisCmd(['EXPIRE', voteKey, '2592000']);

    const countRes = await redisCmd(['INCR', `votes:${pixelId}`]);
    const count = countRes.result || 0;

    // Get likes to determine threshold
    const likesRes = await redisCmd(['GET', `likes:${pixelId}`]);
    const likes = parseInt(likesRes.result || '0');
    const threshold = getThreshold(likes);

    if (count >= threshold) {
      await redisCmd(['ZREM', 'px:list', pixelId]);
      await redisCmd(['DEL', `px:${pixelId}`]);
      await redisCmd(['DEL', `votes:${pixelId}`]);
      await redisCmd(['DEL', `likes:${pixelId}`]);
      return new Response(JSON.stringify({ ok: true, deleted: true, count, threshold }), { headers: HEADERS });
    }

    return new Response(JSON.stringify({ ok: true, deleted: false, count, threshold }), { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: HEADERS });
  }
}
