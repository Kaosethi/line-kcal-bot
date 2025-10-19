import type { VercelRequest, VercelResponse } from '@vercel/node';
import getRawBody from 'raw-body';
import crypto from 'node:crypto';
import dayjs from 'dayjs';
import tz from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NUTRITION_MAP, matchDish } from '../lib/nutrition.js';

dayjs.extend(utc);
dayjs.extend(tz);
const TZ = process.env.APP_TZ || 'Asia/Bangkok';

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
  api: { bodyParser: false },
};

async function verifySignature(raw: Buffer, headerSig?: string) {
  if (!headerSig) return false;
  const mac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(raw).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(headerSig));
}

async function lineReply(replyToken: string, messages: any[]) {
  const res = await fetch('[https://api.line.me/v2/bot/message/reply](https://api.line.me/v2/bot/message/reply)', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) throw new Error(`LINE reply ${res.status}`);
}

async function linePush(toUserId: string, messages: any[]) {
  const res = await fetch('[https://api.line.me/v2/bot/message/push](https://api.line.me/v2/bot/message/push)', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: toUserId, messages }),
  });
  if (!res.ok) throw new Error(`LINE push ${res.status}`);
}

async function getProfile(lineUserId: string) {
  const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function upsertUser(lineUserId: string) {
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (existing) return existing.id;

  let display_name: string | null = null;
  try {
    const p = await getProfile(lineUserId);
    display_name = p?.displayName ?? null;
  } catch {}

  const { data, error } = await supabase
    .from('users')
    .insert({ line_user_id: lineUserId, display_name })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function getLineImageBuffer(messageId: string): Promise<Buffer> {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`LINE content ${res.status}`);
  const arr = new Uint8Array(await res.arrayBuffer());
  return Buffer.from(arr);
}

async function uploadToSupabase(userId: string, buf: Buffer): Promise<string> {
  const fileName = `${userId}/${Date.now()}.jpg`;
  const { data, error } = await supabase.storage
    .from('meals')
    .upload(fileName, buf, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  const { data: pub } = supabase.storage.from('meals').getPublicUrl(data.path);
  return pub.publicUrl;
}

// ===================================================================
//
// ⬇️ ⬇️ ⬇️ UPDATED FUNCTIONS START HERE ⬇️ ⬇️ ⬇️
//
// ===================================================================

/**
 * [UPDATED] Analyzes an image for *all* food items and returns an array.
 */
async function analyzeImage(imageUrl: string) {
  const SYSTEM = `You are a nutrition assistant. Analyze the food image.
Identify ALL food items and dishes in the image.
- If it is a dish, identify it.
- If it is a branded product, identify the brand and product name.
- If unsure, use "unknown".
Return ONLY JSON as an array, even for a single item:
[{"dish_name":"string","portion":"string","confidence":0.0}]

---
EXAMPLES:
User sends image of a single smoothie: [{"dish_name": "Dee's Mixedberry High Protein Smoothie", "portion": "500 ML", "confidence": 0.95}]
User sends image of a table with two dishes: [{"dish_name": "Pad Krapow Moo", "portion": "1 serving", "confidence": 0.9}, {"dish_name": "Tom Yum Goong", "portion": "1 bowl", "confidence": 0.85}]
User sends a blurry/unclear image: [{"dish_name": "unknown", "portion": "", "confidence": 0.1}]
---
`;

  console.log(`[DEBUG] analyzeImage: Fetching image from ${imageUrl}`);
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch image from Supabase: ${imageResponse.status}`);
  }
  const imageBuffer = await imageResponse.arrayBuffer();
  const imageBase64 = Buffer.from(imageBuffer).toString('base64');

  const imagePart = {
    inlineData: {
      data: imageBase64,
      mimeType: 'image/jpeg',
    },
  };

  console.log('[DEBUG] analyzeImage: Calling Gemini with image...');
  const result = await gemini.generateContent({
    contents: [{ role: 'user', parts: [{ text: SYSTEM }, imagePart] }],
  });

  const out = result.response.text().trim();
  console.log('[DEBUG] analyzeImage: Gemini raw response:', out);

  const match = out.match(/\[[\s\S]*\]/); // Find text between [ and ]
  const jsonText = match ? match[0] : '[]'; // Default to an empty array string

  try {
    const j = JSON.parse(jsonText);
    
    if (Array.isArray(j) && j.length > 0) {
      return j.map((item: any) => ({
        dish_name: String(item.dish_name || 'unknown').trim(),
        portion: String(item.portion || '').trim(),
        confidence: Number(item.confidence || 0),
      }));
    }
    
    console.log('[WARN] analyzeImage: Parsed JSON was not an array or was empty.', jsonText);
    return [{ dish_name: 'unknown', portion: '', confidence: 0 }];
  } catch (e) {
    console.error('[ERROR] analyzeImage: Failed to parse JSON array.', e, 'Raw text was:', jsonText);
    return [{ dish_name: 'unknown', portion: '', confidence: 0 }];
  }
}

/**
 * [UPDATED] Estimates nutrition for a dish, using portion string for better accuracy.
 */
async function estimateNutrition(dishName: string, portion?: string) {
  const key = matchDish(dishName);
  if (key) return { ...NUTRITION_MAP[key], source: `map:${key}` as const };

  const prompt = `For "${dishName}" (${portion || 'typical one-serving'}), give JSON {kcal,protein_g,carbs_g,fat_g} numbers only.`;
  
  console.log(`[DEBUG] estimateNutrition: Calling Gemini with prompt: ${prompt}`);
  
  const r = await gemini.generateContent({
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
  });
  let out = r.response.text().trim();
  console.log('[DEBUG] estimateNutrition: Gemini raw response:', out);

  const match = out.match(/{[\s\S]*}/); // Find text between { and }
  const jsonText = match ? match[0] : '';

  try {
    const j = JSON.parse(jsonText);
    return {
      kcal: Number(j.kcal ?? 500),
      protein_g: Number(j.protein_g ?? 20),
      carbs_g: Number(j.carbs_g ?? 60),
      fat_g: Number(j.fat_g ?? 18),
      source: 'gemini' as const,
    };
  } catch (e) {
    console.error('[ERROR] estimateNutrition: Failed to parse JSON.', e, 'Raw text was:', jsonText);
    return { kcal: 500, protein_g: 20, carbs_g: 60, fat_g: 18, source: 'default' as const };
  }
}

/**
 * [UPDATED] Formats the meal line with the clean, multi-line macro style.
 */
function fmtMealLine(name: string, kcal: number, p?: number, c?: number, f?: number) {
  // Main dish line
  const mainLine = `${name} — ~${Math.round(kcal)} kcal`;

  // Create macro lines, indented, and only if the value exists
  const macroParts = [
    p && `  Protein: ${Math.round(p)}g`,
    c && `  Carbs: ${Math.round(c)}g`,
    f && `  Fat: ${Math.round(f)}g`,
  ].filter(Boolean); // This removes any null/undefined entries

  // Join them with a newline
  const macroString = macroParts.length > 0 ? `\n${macroParts.join('\n')}` : '';

  // Return the combined string
  return `${mainLine}${macroString}`;
}

async function summarize(lineUserId: string, span: 'day' | 'week') {
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
  const total = meals.reduce(
    (acc: any, m: any) => {
      acc.kcal += Number(m.calories_kcal || 0);
      acc.p += Number(m.protein_g || 0);
      acc.c += Number(m.carbs_g || 0);
      acc.f += Number(m.fat_g || 0);
      return acc;
    },
    { kcal: 0, p: 0, c: 0, f: 0 }
);
  // Use the new fmtMealLine for the summary too!
  const lines = meals.map((m: any) => `• ${fmtMealLine(m.dish_name, m.calories_kcal, m.protein_g, m.carbs_g, m.fat_g)}`);
  return [
    `📊 ${span === 'day' ? 'Today' : 'This week'} summary`,
    `Total: ~${Math.round(total.kcal)} kcal (P${Math.round(total.p)} / C${Math.round(total.c)} / F${Math.round(total.f)})`,
    '',
    ...lines,
  ].join('\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ✅ respond to LINE Verify (GET request)
  if (req.method !== 'POST') {
    res.status(200).send('LINE KCal Bot is running ✅');
    return;
  }

  try {
    const raw = await getRawBody(req);
    const sig = req.headers['x-line-signature'] as string | undefined;
    const ok = await verifySignature(raw, sig);
    if (!ok) return res.status(401).send('Bad signature');

    const body = JSON.parse(raw.toString('utf8'));
    const events = body.events || [];

    await Promise.all(
      events.map(async (event: any) => {
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
          await lineReply(event.replyToken, [
            { type: 'text', text: `Send a meal photo.\nCommands:\n• summary day\n• summary week` },
          ]);
          return;
        }

        // ===================================================================
        //
        // ⬇️ ⬇️ ⬇️ UPDATED IMAGE HANDLER LOGIC ⬇️ ⬇️ ⬇️
        //
        // ===================================================================
        if (event.message.type === 'image') {
          await lineReply(event.replyToken, [{ type: 'text', text: 'Analyzing your meal… 🍱' }]);
          
          try {
            const buf = await getLineImageBuffer(event.message.id);
            const imageUrl = await uploadToSupabase(userDbId, buf);

            // 1. 'parsedItems' is now an array, e.g., [{dish_name: 'Pad Krapow'}, {dish_name: 'Rice'}]
            const parsedItems = await analyzeImage(imageUrl);

            // 2. Get nutrition for all items in parallel
            const nutritionPromises = parsedItems.map(item =>
              estimateNutrition(item.dish_name, item.portion)
            );
            const nutritionResults = await Promise.all(nutritionPromises);

            // 3. Prepare an array of meal rows for Supabase
            const taken_at = dayjs().tz(TZ).toDate();
            const mealRows = parsedItems.map((item, index) => {
              const nutrition = nutritionResults[index];
              return {
                user_id: userDbId,
                taken_at,
                image_url: imageUrl,
                dish_name: item.dish_name || 'unknown',
                portion: item.portion || null,
                confidence: item.confidence ?? null,
                calories_kcal: nutrition.kcal,
                protein_g: nutrition.protein_g,
                carbs_g: nutrition.carbs_g,
                fat_g: nutrition.fat_g,
                raw_ai: { parsed: item, nutrition },
              };
            });

            // 4. Insert all meal rows into Supabase in one go
            const { error } = await supabase.from('meals').insert(mealRows);
            if (error) {
              console.error('[ERROR] Supabase insert multi-error:', error.message);
              throw error;
            }

            // 5. Format a summary reply for LINE
            let totalKcal = 0;
            const lineItems: string[] = [];

            mealRows.forEach(row => {
              // Only add non-unknown items to the reply
              if (row.dish_name.toLowerCase() !== 'unknown') {
                totalKcal += row.calories_kcal;
                lineItems.push(
                  `• ${fmtMealLine(row.dish_name, row.calories_kcal, row.protein_g, row.carbs_g, row.fat_g)}`
                );
              }
            });

            // If all items were unknown, send a fallback
            if (lineItems.length === 0) {
              await linePush(lineUserId, [{ type: 'text', text: "Sorry, I couldn't identify any dishes in that photo." }]);
              return;
            }
            
            // Send the summary message
            const replyText = [
              `Logged ${lineItems.length} items — Total ~${Math.round(totalKcal)} kcal`,
              ...lineItems,
            ].join('\n');

            await linePush(lineUserId, [{ type: 'text', text: replyText }]);

          } catch (e: any) {
            console.error('[ERROR] Main image handler catch:', e.message);
            await linePush(lineUserId, [
              {
                type: 'text',
                text: `Oops, couldn't analyze that image (${e.message}). Try another angle or add a short caption.`,
              },
            ]);
          }
        }
      })
    );

    res.status(200).send('OK');
  } catch (err: any) {
    console.error('[ERROR] Top-level handler catch:', err.message);
    res.status(500).send(err?.message || 'error');
  }
}