import { z } from 'zod';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/**
 * How an Agent's tools are approved. `ask`: reading and editing files in its
 * folder runs freely, except editing Pero's system folder, and any other
 * tool that needs permission asks the owner in the Channel. `bypass`: every tool runs without asking, like
 * `claude --dangerously-skip-permissions`.
 */
export const PERMISSION_MODES = ['ask', 'bypass'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const permissionModeSchema = z.enum(PERMISSION_MODES);

/**
 * The tools an Agent may use. A missing field takes its default, so the
 * `{}` stored before any field existed still reads as a valid policy.
 */
export const toolPolicySchema = z.strictObject({
  permissions: permissionModeSchema.default('ask'),
});

export type ToolPolicy = z.infer<typeof toolPolicySchema>;
