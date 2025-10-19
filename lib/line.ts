import crypto from 'node:crypto';

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

export async function verifySignature(raw: Buffer, headerSig?: string) {
  if (!headerSig) return false;
  const mac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(raw).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(headerSig));
}

export async function lineReply(replyToken: string, messages: any[]) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) throw new Error(`LINE reply ${res.status}`);
}

export async function linePush(toUserId: string, messages: any[]) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: toUserId, messages }),
  });
  if (!res.ok) throw new Error(`LINE push ${res.status}`);
}

export async function getProfile(lineUserId: string) {
  const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function getLineImageBuffer(messageId: string): Promise<Buffer> {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`LINE content ${res.status}`);
  const arr = new Uint8Array(await res.arrayBuffer());
  return Buffer.from(arr);
}