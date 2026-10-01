import type { InboundCommand } from '../channel-adapter.js';

// Shared by the integrations and the daemon. Keep this free of Nest imports.

/** A command Pero answers itself, as integrations list it. */
export interface CommandInfo {
  /** Lowercase letters, digits, and `_`, without the `/`. */
  name: string;
  /** One line for the integration's command menu and `/help`. */
  description: string;
}

/** Every command, in the order menus show them. */
export const COMMANDS: readonly CommandInfo[] = [
  {
    name: 'status',
    description: "This topic's Agent, its conversation, and Pero",
  },
  {
    name: 'new',
    description: 'Start this topic over, without the conversation so far',
  },
  { name: 'stop', description: "Stop the Agent's answer in this topic" },
  { name: 'model', description: "Show or change this topic's Agent's model" },
  {
    name: 'effort',
    description: "Show or change this topic's Agent's reasoning effort",
  },
  { name: 'help', description: "What Pero's commands do" },
];

const NAMES: ReadonlySet<string> = new Set(COMMANDS.map(({ name }) => name));

/** Whether Pero answers `/name` itself rather than its Agent. */
export function isCommand(name: string): boolean {
  return NAMES.has(name);
}

/**
 * The command a button runs: its ID is the command's text, such as
 * `/new yes`. Null for any other ID, such as a tool request's.
 */
export function buttonCommand(actionId: string): InboundCommand | null {
  if (!actionId.startsWith('/')) return null;
  const [name = '', ...rest] = actionId.slice(1).split(' ');
  return { name: name.toLowerCase(), args: rest.join(' ').trim() };
}
