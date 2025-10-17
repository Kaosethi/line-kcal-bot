import type { VercelRequest, VercelResponse } from '@vercel/node';
import getRawBody from 'raw-body';
import crypto from 'node:crypto';
import dayjs from 'dayjs';
import tz from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NUTRITION_MAP, matchDish } from '../lib/nutrition.js';

dayjs.extend(utc); dayjs.extend(tz);
const TZ = process.env.TZ || 'Asia/Bangkok';

// ---- ENV ----
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

export const config = {
  api: {
    bodyParser: false, // we need raw body for LINE signature
  },
};

async function verifySignature(raw: Buffer, headerSig?: string) {
  if (!headerSig) return false;
  const mac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(raw).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(headerSig));
}

async function lineReply(replyToken: string, messages: any[]) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!res.ok) throw new Error(`LINE reply ${res.status}`);
}

async function linePush(toUserId: string, messages: any[]) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ to: toUserId, messages })
  });
  if (!res.ok) throw new Error(`LINE push ${res.status}`);
}

async function getProfile(lineUserId: string) {
  const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function upsertUser(lineUserId: string) {
  const { data: existing } = await supabase.from('users').select('id').eq('line_user_id', lineUserId).maybeSingle();
  if (existing) return existing.id;
  let display_name: string | null = null;
  try {
    const p = await getProfile(lineUserId);
    display_name = p?.displayName ?? null;
  } catch {}
  const { data, error } = await supabase.from('users').insert({ line_user_id: lineUserId, display_name }).select('id').single();
  if (error) throw error;
  return data.id;
}

async function getLineImageBuffer(messageId: string): Promise<Buffer> {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } });
  if (!res.ok) throw new Error(`LINE content ${res.status}`);
  const arr = new Uint8Array(await res.arrayBuffer());
  return Buffer.from(arr);
}

async function uploadToSupabase(userId: string, buf: Buffer): Promise<string> {
  const fileName = `${userId}/${Date.now()}.jpg`;
  const { data, error } = await supabase.storage.from('meals').upload(fileName, buf, {
    contentType: 'image/jpeg',
    upsert: false
  });
  if (error) throw error;
  const { data: pub } = supabase.storage.from('meals').getPublicUrl(data.path);
  return pub.publicUrl;
}

async function analyzeImage(imageUrl: string) {
  const SYSTEM = `You are a nutrition assistant for a LINE calorie bot in Thailand.
Return ONLY JSON matching:
{"dish_name":"string","portion":"string","confidence":0.0}
Use common Thai/Asian dish names. Pick the main dish if multiple.`;

  const result = await gemini.generateContent({
    contents: [{
      role: 'user',
      parts: [{ text: SYSTEM }, { text: 'Image URL:' }, { text: imageUrl }]
    }]
  });
  const out = result.response.text().trim();
  const jsonText = out.startsWith('{') ? out : out.slice(out.indexOf('{'));
  try {
    const j = JSON.parse(jsonText);
    return {
      dish_name: String(j.dish_name || 'unknown').trim(),
      portion: String(j.portion || '').trim(),
      confidence: Number(j.confidence || 0)
    };
  } catch {
    return { dish_name: 'unknown', portion: '', confidence: 0 };
  }
}

async function estimateNutrition(dishName: string) {
  const key = matchDish(dishName);
  if (key) return { ...NUTRITION_MAP[key], source: `map:${key}` as const };

  const r = await gemini.generateContent({
    contents: [{ role: 'user', parts: [{ text:
      `For "${dishName}", give JSON {kcal,protein_g,carbs_g,fat_g} numbers only, typical one-serving.` }] }]
  });
  let out = r.response.text().trim();
  if (!out.startsWith('{')) out = out.slice(out.indexOf('{'));
  try {
    const j = JSON.parse(out);
    return {
      kcal: Number(j.kcal ?? 500),
      protein_g: Number(j.protein_g ?? 20),
      carbs_g: Number(j.carbs_g ?? 60),
      fat_g: Number(j.fat_g ?? 18),
      source: 'gemini' as const
    };
  } catch {
    return { kcal: 500, protein_g: 20, carbs_g: 60, fat_g: 18, source: 'default' as const };
  }
}

function fmtMealLine(name: string, kcal: number, p?: number, c?: number, f?: number) {
  const macro = [p && `P${Math.round(p)}g`, c && `C${Math.round(c)}g`, f && `F${Math.round(f)}g`].filter(Boolean).join(' / ');
  return `${name} — ~${Math.round(kcal)} kcal${macro ? ` (${macro})` : ''}`;
}

async function summarize(lineUserId: string, span: 'day'|'week') {
  const { data: u } = await supabase.from('users').select('id').eq('line_user_id', lineUserId).maybeSingle();
  if (!u) return 'No meals yet.';
  const now = dayjs().tz(TZ);
  const start = span === 'day' ? now.startOf('day') : now.startOf('week');
  const { data: meals, error } = await supabase
    .from('meals')
    .select('dish_name, calories_kcal, protein_g, carbs_g, fat_g, taken_at')
    .eq('user_id', u.id)
    .gte('taken_at', start.utc().toISOString())
    .lte('taken_at', now.utc().toISOString())
    .order('taken_at', { ascending: true });
  if (error) throw error;
  if (!meals || meals.length === 0) return `No meals in this ${span}.`;
  const total = meals.reduce((acc: any, m: any) => {
    acc.kcal += Number(m.calories_kcal || 0);
    acc.p += Number(m.protein_g || 0);
    acc.c += Number(m.carbs_g || 0);
    acc.f += Number(m.fat_g || 0);
    return acc;
  }, { kcal: 0, p: 0, c: 0, f: 0 });
  const lines = meals.map((m: any) => `• ${fmtMealLine(m.dish_name, m.calories_kcal, m.protein_g, m.carbs_g, m.fat_g)}`);
  return [
    `📊 ${span === 'day' ? 'Today' : 'This week'} summary`,
    `Total: ~${Math.round(total.kcal)} kcal (P${Math.round(total.p)} / C${Math.round(total.c)} / F${Math.round(total.f)})`,
    '',
    ...lines
  ].join('\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const raw = await getRawBody(req);
    const sig = req.headers['x-line-signature'] as string | undefined;
    const ok = await verifySignature(raw, sig);
    if (!ok) return res.status(401).send('Bad signature');

    const body = JSON.parse(raw.toString('utf8'));
    const events = body.events || [];

    await Promise.all(events.map(async (event: any) => {
      if (event.type !== 'message') return;
      const lineUserId = event.source?.userId as string;
      const userDbId = await upsertUser(lineUserId);

      if (event.message.type === 'text') {
        const t = (event.message.text || '').toLowerCase().trim();
        if (t === 'summary day' || t === 'summary week') {
          const msg = await summarize(lineUserId, t.endsWith('day') ? 'day' : 'week');
          await lineReply(event.replyToken, [{ type: 'text', text: msg }]);
          return;
        }
        await lineReply(event.replyToken, [{ type: 'text', text: `Send a meal photo.\nCommands:\n• summary day\n• summary week` }]);
        return;
      }

      if (event.message.type === 'image') {
        // Reply fast to avoid timeout, then do the heavy work + push.
        await lineReply(event.replyToken, [{ type: 'text', text: 'Analyzing your meal… 🍱' }]);
        try {
          const buf = await getLineImageBuffer(event.message.id);
          const imageUrl = await uploadToSupabase(userDbId, buf);
          const parsed = await analyzeImage(imageUrl);
          const nutrition = await estimateNutrition(parsed.dish_name);
          const taken_at = dayjs().tz(TZ).toDate();

          const { error } = await supabase.from('meals').insert({
            user_id: userDbId,
            taken_at,
            image_url: imageUrl,
            dish_name: parsed.dish_name || 'unknown',
            portion: parsed.portion || null,
            confidence: parsed.confidence ?? null,
            calories_kcal: nutrition.kcal,
            protein_g: nutrition.protein_g,
            carbs_g: nutrition.carbs_g,
            fat_g: nutrition.fat_g,
            raw_ai: { parsed, nutrition }
          });
          if (error) throw error;

          const line = fmtMealLine(parsed.dish_name, nutrition.kcal, nutrition.protein_g, nutrition.carbs_g, nutrition.fat_g);
          const tip = parsed.confidence && parsed.confidence < 0.6 ? `\n(Confidence low—reply the correct dish name to improve future matches.)` : '';
          await linePush(lineUserId, [{ type: 'text', text: `Logged: ${line}${tip}` }]);
        } catch (e: any) {
          await linePush(lineUserId, [{ type: 'text', text: `Oops, couldn't analyze that image (${e.message}). Try another angle or add a short caption.` }]);
        }
        return;
      }
    }));

    res.status(200).send('OK');
  } catch (err: any) {
    res.status(500).send(err?.message || 'error');
  }
}
