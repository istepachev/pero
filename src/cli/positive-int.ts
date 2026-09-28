/** `value` as a whole number of at least 1, or null when it is not one. */
export function positiveInt(value: string): number | null {
  const number = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(number) && number >= 1
    ? number
    : null;
}
