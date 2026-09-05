import { z } from "zod";

export const MAX_FAVORITES = 500;
export const favoriteNumberSchema = z.string().regex(/^\d{4,10}$/).transform(number => String(Number(number)).padStart(4, "0"));
export const favoriteInputSchema = z.object({
  title: z.string().trim().min(1).max(1000),
  tags: z.array(z.string().trim().min(1).max(40).refine(tag => !tag.includes(","), "Stichwörter einzeln angeben.")).max(10)
    .transform(tags => tags.filter((tag, index) => tags.findIndex(item => item.toLocaleLowerCase("de") === tag.toLocaleLowerCase("de")) === index)),
  memo: z.string().trim().max(2000),
}).strict();
export const favoriteSchema = favoriteInputSchema.extend({ number: favoriteNumberSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type Favorite = z.infer<typeof favoriteSchema>;

export function filterFavorites(entries: Favorite[], query: string, tag: string): Favorite[] {
  const needle = query.trim().toLocaleLowerCase("de");
  const wantedTag = tag.trim().toLocaleLowerCase("de");
  return entries.filter(entry => (!wantedTag || entry.tags.some(item => item.toLocaleLowerCase("de") === wantedTag)) &&
    (!needle || [entry.number, entry.title, entry.memo, ...entry.tags].some(value => value.toLocaleLowerCase("de").includes(needle))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.number.localeCompare(b.number));
}
