export const config = { runtime: 'edge' };

export default async function handler(req) {
  const token = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_CHAT_USERNAME || 'eSimpsonConnection';

  if (!token) {
    return new Response(JSON.stringify({ count: null, error: 'no token' }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=3600' }
    });
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getChatMemberCount?chat_id=@${chat}`);
    const data = await res.json();

    if (!data.ok) throw new Error(data.description);

    return new Response(JSON.stringify({ count: data.result }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ count: null, error: e.message }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=300' }
    });
  }
}
