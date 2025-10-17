export type Nutri = { kcal: number; protein_g: number; carbs_g: number; fat_g: number; };

export const NUTRITION_MAP: Record<string, Nutri> = {
  "khao man gai": { kcal: 680, protein_g: 35, carbs_g: 85, fat_g: 20 },
  "khao moo daeng": { kcal: 650, protein_g: 28, carbs_g: 90, fat_g: 18 },
  "pad kra pao moo kai dao": { kcal: 720, protein_g: 35, carbs_g: 75, fat_g: 28 },
  "pad thai": { kcal: 600, protein_g: 24, carbs_g: 85, fat_g: 18 },
  "som tum": { kcal: 120, protein_g: 3, carbs_g: 20, fat_g: 2 },
  "moo ping (2 sticks)": { kcal: 260, protein_g: 18, carbs_g: 8, fat_g: 16 },
  "omelet rice": { kcal: 550, protein_g: 20, carbs_g: 75, fat_g: 18 },
  "grilled chicken (quarter)": { kcal: 300, protein_g: 40, carbs_g: 0, fat_g: 14 },
  "fried rice": { kcal: 630, protein_g: 20, carbs_g: 90, fat_g: 20 }
};

export function matchDish(name: string): string | null {
  const norm = name.toLowerCase().trim();
  const keys = Object.keys(NUTRITION_MAP);

  let best = keys.find(k => norm === k || norm.includes(k));
  if (best) return best;

  const tokens = new Set(norm.split(/\s|,|-/).filter(Boolean));
  let bestKey: string | null = null;
  let bestScore = 0;
  for (const k of keys) {
    const t2 = new Set(k.split(/\s|,|-/).filter(Boolean));
    let score = 0;
    for (const t of t2) if (tokens.has(t)) score++;
    if (score > bestScore) { bestScore = score; bestKey = k; }
  }
  return bestScore >= 1 ? bestKey : null;
}
