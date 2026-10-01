import type { Prompts } from '../prompts.js';

/**
 * Terminal output in blocks, one per step of setup, separated by an empty
 * line. Questions count as output, so a block may start with one.
 */
export class BlockOutput {
  private started = false;
  private gap = false;

  constructor(private readonly write: (text: string) => void) {}

  /** Starts a new block: what comes next follows an empty line. */
  readonly block = (): void => {
    this.gap = this.started;
  };

  readonly print = (text: string): void => {
    this.flush();
    this.write(text);
  };

  /** `prompts`, with each question part of the current block. */
  prompts(prompts: Prompts): Prompts {
    return {
      input: (options) => {
        this.flush();
        return prompts.input(options);
      },
      password: (options) => {
        this.flush();
        return prompts.password(options);
      },
      confirm: (options) => {
        this.flush();
        return prompts.confirm(options);
      },
      select: (options) => {
        this.flush();
        return prompts.select(options);
      },
    };
  }

  private flush(): void {
    if (this.gap) this.write('');
    this.gap = false;
    this.started = true;
  }
}
