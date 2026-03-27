export const config = { runtime: 'edge' };

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

async function redisMGet(keys) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${url}/mget/${keys.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.result || [];
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
  const url = new URL(req.url);
  const rawId = url.searchParams.get('id') || '';
  const id = sanitizeId(rawId);
  if (!id) return new Response(JSON.stringify({ count: 0, likes: 0, threshold: 5 }), { headers: HEADERS });

  try {
    const [votesVal, likesVal] = await redisMGet([`votes:${id}`, `likes:${id}`]);
    const count = parseInt(votesVal || '0');
    const likes = parseInt(likesVal || '0');
    const threshold = getThreshold(likes);
    return new Response(JSON.stringify({ count, likes, threshold }), {
      headers: { ...HEADERS, 'Cache-Control': 's-maxage=10' }
    });
  } catch {
    return new Response(JSON.stringify({ count: 0, likes: 0, threshold: 5 }), { headers: HEADERS });
  }
}
