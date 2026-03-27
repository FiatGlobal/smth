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

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return new Response(JSON.stringify({ count: 0 }), { headers: HEADERS });

  try {
    const res = await redisCmd(['GET', `votes:${id}`]);
    const count = parseInt(res.result || '0');
    return new Response(JSON.stringify({ count }), {
      headers: { ...HEADERS, 'Cache-Control': 's-maxage=10' }
    });
  } catch {
    return new Response(JSON.stringify({ count: 0 }), { headers: HEADERS });
  }
}
