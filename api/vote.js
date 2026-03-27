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
  if (!hash || typeof hash !== 'string') return false;
  // Sanitize all field values
  const safeFields = {};
  for (const [k, v] of Object.entries(fields)) {
    safeFields[k] = String(v).slice(0, 256);
  }
  const checkString = Object.keys(safeFields).sort().map(k => `${k}=${safeFields[k]}`).join('\n');
  const encoder = new TextEncoder();
  const keyData = await crypto.subtle.digest('SHA-256', encoder.encode(botToken));
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(checkString));
  const computedHash = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (computedHash !== hash) return false;
  const authDate = parseInt(safeFields.auth_date || '0');
  if (Date.now() / 1000 - authDate > 86400) return false;
  return true;
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function getThreshold(likes) {
  if (likes >= 10) return 12;
  if (likes >= 5) return 8;
  return 5;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > 4000) {
    return new Response(JSON.stringify({ error: 'payload_too_large' }), { status: 413, headers: HEADERS });
  }

  try {
    let body;
    try { body = await req.json(); }
    catch { return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: HEADERS }); }

    const { pixelId, tgData } = body;
    if (!pixelId || !tgData || typeof tgData !== 'object') {
      return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400, headers: HEADERS });
    }

    const safeId = sanitizeId(pixelId);
    if (!safeId) return new Response(JSON.stringify({ error: 'invalid_id' }), { status: 400, headers: HEADERS });

    // Check art still exists
    const artExists = await redisCmd(['EXISTS', `px:${safeId}`]);
    if (!artExists.result) {
      return new Response(JSON.stringify({ error: 'art_not_found' }), { status: 404, headers: HEADERS });
    }

    const valid = await verifyTelegramAuth(tgData);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'invalid_auth' }), { status: 401, headers: HEADERS });
    }

    const userId = sanitizeId(String(tgData.id));
    const voteKey = `vote:${safeId}:${userId}`;

    const existing = await redisCmd(['GET', voteKey]);
    if (existing.result) {
      return new Response(JSON.stringify({ error: 'already_voted' }), { status: 409, headers: HEADERS });
    }

    await redisCmd(['SET', voteKey, '1']);
    await redisCmd(['EXPIRE', voteKey, '2592000']);

    const countRes = await redisCmd(['INCR', `votes:${safeId}`]);
    const count = countRes.result || 0;

    const likesRes = await redisCmd(['GET', `likes:${safeId}`]);
    const likes = parseInt(likesRes.result || '0');
    const threshold = getThreshold(likes);

    if (count >= threshold) {
      // Full cleanup on deletion
      await redisCmd(['ZREM', 'px:list', safeId]);
      await redisCmd(['ZREM', 'px:liked', safeId]);
      await redisCmd(['DEL', `px:${safeId}`]);
      await redisCmd(['DEL', `votes:${safeId}`]);
      await redisCmd(['DEL', `likes:${safeId}`]);
      return new Response(JSON.stringify({ ok: true, deleted: true, count, threshold }), { headers: HEADERS });
    }

    return new Response(JSON.stringify({ ok: true, deleted: false, count, threshold }), { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers: HEADERS });
  }
}
