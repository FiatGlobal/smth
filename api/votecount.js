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

function getThreshold(likes) {
  if (likes >= 10) return 12;
  if (likes >= 5) return 8;
  return 5;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return new Response(JSON.stringify({ count: 0, likes: 0, threshold: 5 }), { headers: HEADERS });

  try {
    const [votesRes, likesRes] = await Promise.all([
      redisCmd(['GET', `votes:${id}`]),
      redisCmd(['GET', `likes:${id}`])
    ]);
    const count = parseInt(votesRes.result || '0');
    const likes = parseInt(likesRes.result || '0');
    const threshold = getThreshold(likes);
    return new Response(JSON.stringify({ count, likes, threshold }), {
      headers: { ...HEADERS, 'Cache-Control': 's-maxage=10' }
    });
  } catch {
    return new Response(JSON.stringify({ count: 0, likes: 0, threshold: 5 }), { headers: HEADERS });
  }
}
