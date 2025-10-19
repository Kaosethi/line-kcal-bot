import { GoogleGenerativeAI } from '@google/generative-ai';
import { NUTRITION_MAP, matchDish } from './nutrition.js';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY!;
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

export async function analyzeImage(imageUrl: string) {
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

export async function estimateNutrition(dishName: string, portion?: string) {
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