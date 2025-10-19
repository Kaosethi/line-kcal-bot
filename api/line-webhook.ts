import type { VercelRequest, VercelResponse } from '@vercel/node';
import getRawBody from 'raw-body';
import dayjs from 'dayjs';

// Import all our new modular functions
import { lineReply, linePush, verifySignature, getLineImageBuffer } from '../lib/line.js';
import { upsertUser, uploadToSupabase, saveMeals } from '../lib/supabase.js';
import { analyzeImage, estimateNutrition } from '../lib/gemini.js';
import { fmtMealLine, summarize } from '../lib/formatters.js';

export const config = {
  api: { bodyParser: false },
};

const TZ = process.env.APP_TZ || 'Asia/Bangkok';

/**
 * Handles text-based commands (e.g., "summary")
 */
async function handleTextMessage(event: any, lineUserId: string) {
  const t = (event.message.text || '').toLowerCase().trim();
  
  if (t === 'summary day' || t === 'summary week') {
    const msg = await summarize(lineUserId, t.endsWith('day') ? 'day' : 'week');
    await lineReply(event.replyToken, [{ type: 'text', text: msg }]);
  } else {
    await lineReply(event.replyToken, [
      { type: 'text', text: `Send a meal photo.\nCommands:\n• summary day\n• summary week` },
    ]);
  }
}

/**
 * Handles the full image analysis workflow
 */
async function handleImageMessage(event: any, lineUserId: string, userDbId: string) {
  await lineReply(event.replyToken, [{ type: 'text', text: 'Analyzing your meal… 🍱' }]);

  try {
    const buf = await getLineImageBuffer(event.message.id);
    const imageUrl = await uploadToSupabase(userDbId, buf);

    // 1. Analyze
    const parsedItems = await analyzeImage(imageUrl);

    // 2. Get nutrition
    const nutritionPromises = parsedItems.map(item =>
      estimateNutrition(item.dish_name, item.portion)
    );
    const nutritionResults = await Promise.all(nutritionPromises);

    // 3. Format rows for Supabase
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

    // 4. Save to DB
    await saveMeals(mealRows);

    // 5. Format reply
    let totalKcal = 0;
    const lineItems: string[] = [];

    mealRows.forEach(row => {
      if (row.dish_name.toLowerCase() !== 'unknown') {
        totalKcal += row.calories_kcal;
        lineItems.push(
          `• ${fmtMealLine(row.dish_name, row.calories_kcal, row.protein_g, row.carbs_g, row.fat_g)}`
        );
      }
    });

    if (lineItems.length === 0) {
      await linePush(lineUserId, [{ type: 'text', text: "Sorry, I couldn't identify any dishes in that photo." }]);
      return;
    }
    
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

/**
 * Main Vercel serverless function (the "traffic cop")
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(200).send('LINE KCal Bot is running ✅');
    return;
  }

  try {
    // 1. Verify request
    const raw = await getRawBody(req);
    const sig = req.headers['x-line-signature'] as string | undefined;
    if (!(await verifySignature(raw, sig))) {
      return res.status(401).send('Bad signature');
    }

    const body = JSON.parse(raw.toString('utf8'));
    const events = body.events || [];

    // 2. Process all events
    await Promise.all(
      events.map(async (event: any) => {
        if (event.type !== 'message') return;

        const lineUserId = event.source?.userId as string;
        const userDbId = await upsertUser(lineUserId);

        // 3. Route to the correct handler
        if (event.message.type === 'text') {
          await handleTextMessage(event, lineUserId);
        } else if (event.message.type === 'image') {
          await handleImageMessage(event, lineUserId, userDbId);
        }
      })
    );

    res.status(200).send('OK');
  } catch (err: any) {
    console.error('[ERROR] Top-level handler catch:', err.message);
    res.status(500).send(err?.message || 'error');
  }
}