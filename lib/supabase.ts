import { createClient } from '@supabase/supabase-js';
import { getProfile } from './line.js'; // We'll import from our new module

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

export async function upsertUser(lineUserId: string) {
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

export async function uploadToSupabase(userId: string, buf: Buffer): Promise<string> {
  const fileName = `${userId}/${Date.now()}.jpg`;
  const { data, error } = await supabase.storage
    .from('meals')
    .upload(fileName, buf, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  const { data: pub } = supabase.storage.from('meals').getPublicUrl(data.path);
  return pub.publicUrl;
}

// This is the logic we moved from the main handler
export async function saveMeals(mealRows: any[]) {
  const { error } = await supabase.from('meals').insert(mealRows);
  if (error) {
    console.error('[ERROR] Supabase insert multi-error:', error.message);
    throw error;
  }
  return true;
}