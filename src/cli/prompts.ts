/** The questions a command may ask on a terminal. */
export interface Prompts {
  /** A line of text; `initial` is prefilled for editing. */
  input(options: { message: string; initial?: string }): Promise<string>;
  /** A line of text that is not shown as it is typed. */
  password(options: { message: string }): Promise<string>;
}

/** Whether both ends are a terminal, so a command may ask questions. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Prompts on this terminal. Loaded only when a command asks something. */
export async function terminalPrompts(): Promise<Prompts> {
  const inquirer = await import('@inquirer/prompts');
  return {
    input: ({ message, initial }) =>
      inquirer.input({
        message,
        ...(initial === undefined
          ? {}
          : { default: initial, prefill: 'editable' as const }),
      }),
    password: ({ message }) => inquirer.password({ message }),
  };
}

/** The owner closed a prompt with Ctrl-C or Ctrl-D. */
export function isPromptExit(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError';
}

/** All of standard input, without its final line break. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}
