// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

export const SLUG_MAX_LENGTH = 64;

/**
 * Letters that dropping accents cannot turn into `a`–`z`, spelled in those:
 * Cyrillic (Russian, Ukrainian, Belarusian) and a few Latin ones.
 */
// prettier-ignore
const SPELLED: Readonly<Record<string, string>> = {
  æ: 'ae', ð: 'd', đ: 'd', ł: 'l', ø: 'o', œ: 'oe', ß: 'ss', þ: 'th',
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'e', є: 'ye',
  ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'yi', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ў: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/**
 * A slug made from any text, such as a topic title: Cyrillic is spelled in
 * Latin letters, accents are dropped (`Café` becomes `cafe`), and every run
 * of anything else becomes one hyphen. Null when no letter or digit is left.
 */
export function slugify(text: string): string | null {
  const latin = text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^a-z0-9]/gu, (char) => SPELLED[char] ?? char)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  const slug = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-$/, '');
  return slug === '' ? null : slug;
}
