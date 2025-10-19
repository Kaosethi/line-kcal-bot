import dayjs from 'dayjs';
import tz from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { supabase } from './supabase.js'; // Import our new supabase module

dayjs.extend(utc);
dayjs.extend(tz);
const TZ = process.env.APP_TZ || 'Asia/Bangkok';

export function fmtMealLine(name: string, kcal: number, p?: number, c?: number, f?: number) {
  // Main dish line
  const mainLine = `${name} — ~${Math.round(kcal)} kcal`;

  // Create macro lines, indented, and only if the value exists
  const macroParts = [
    p && `  Protein: ${Math.round(p)}g`,
    c && `  Carbs: ${Math.round(c)}g`,
    f && `  Fat: ${Math.round(f)}g`,
  ].filter(Boolean);

  const macroString = macroParts.length > 0 ? `\n${macroParts.join('\n')}` : '';
  return `${mainLine}${macroString}`;
}

export async function summarize(lineUserId: string, span: 'day' | 'week') {
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