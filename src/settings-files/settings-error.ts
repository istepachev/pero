// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * One problem with a settings note, as `pero check`, `pero status`, and the
 * log report it.
 */
export interface SettingsError {
  /** The note's path inside the settings folder, such as `Agents/Coach.md`. */
  file: string;
  /** The property at fault, as written in the note; null for the whole note. */
  property: string | null;
  message: string;
}
