// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** `value` without its undefined fields, so they do not overwrite others. */
export function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}
