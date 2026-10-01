/** The questions a command may ask on a terminal. */
export interface Prompts {
  /**
   * A line of text; `initial` is prefilled for editing. Aborting `signal`
   * closes the prompt with an error `isPromptAbort` recognizes.
   */
  input(options: {
    message: string;
    initial?: string;
    signal?: AbortSignal;
  }): Promise<string>;
  /** A line of text shown as `*` as it is typed. */
  password(options: { message: string }): Promise<string>;
  /** A yes or no question; `initial` is the answer Enter gives. */
  confirm(options: { message: string; initial?: boolean }): Promise<boolean>;
}

/** Whether both ends are a terminal, so a command may ask questions. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Prompts on this terminal. Loaded only when a command asks something. */
export async function terminalPrompts(): Promise<Prompts> {
  const inquirer = await import('@inquirer/prompts');
  return {
    input: ({ message, initial, signal }) =>
      inquirer.input(
        {
          message,
          ...(initial === undefined
            ? {}
            : { default: initial, prefill: 'editable' as const }),
        },
        signal === undefined ? {} : { signal },
      ),
    password: ({ message }) => inquirer.password({ message, mask: '*' }),
    confirm: ({ message, initial }) =>
      inquirer.confirm({
        message,
        ...(initial === undefined ? {} : { default: initial }),
      }),
  };
}

/** The owner closed a prompt with Ctrl-C or Ctrl-D. */
export function isPromptExit(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError';
}

/** A prompt closed because its `signal` was aborted, not by the owner. */
export function isPromptAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortPromptError';
}

/** All of standard input, without its final line break. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}
