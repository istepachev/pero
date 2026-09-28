import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import {
  ConflictError,
  describeIssues,
  InvalidInputError,
  NotFoundError,
  parseInput,
} from '../common/errors.js';
import { withoutUndefined } from '../common/without-undefined.js';
import {
  type AgentCreate,
  type AgentEdit,
  agentCreateSchema,
  agentEditSchema,
} from '../config/agent-input.js';
import {
  mergeOptions,
  PROVIDER_OPTIONS_SCHEMAS,
  type Provider,
  type ProviderOptions,
} from '../config/provider-options.js';
import type { ToolPolicy } from '../config/tool-policy.js';
import { validateWorkingDirectory } from '../config/working-directory.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import {
  composeInstructions,
  effectiveWorkingDirectory,
} from './agent-resolution.js';

const NO_DEFAULT_FOLDER =
  'No default working directory is set: give the Agent its own folder, ' +
  'or set the default working directory first';

/** What a runtime needs from an Agent, with defaults already applied. */
export interface ResolvedAgent {
  id: number;
  name: string;
  provider: Provider;
  providerOptions: ProviderOptions;
  workingDirectory: string;
  instructions: string;
  toolPolicy: ToolPolicy;
  /** Whether a Codex Agent may work in a folder outside a Git repository. */
  codexSkipGitRepoCheck: boolean;
  enabled: boolean;
}

/** Creates, edits, and resolves Agent definitions. */
@Injectable()
export class AgentsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  list(): Promise<Agent[]> {
    return this.dataSource
      .getRepository(Agent)
      .find({ order: { name: 'ASC' } });
  }

  get(name: string): Promise<Agent> {
    return findAgent(this.dataSource.manager, name);
  }

  /**
   * Creates an Agent. Provider, options, and permissions not given are
   * copied from the installation defaults; without a folder of its own, it
   * follows the default working directory, which must then be set.
   */
  create(input: AgentCreate): Promise<Agent> {
    return inTransaction(this.dataSource, (manager) =>
      this.createWithin(manager, input),
    );
  }

  /**
   * `create` inside the caller's transaction, so the Agent commits or rolls
   * back with whatever else the caller writes there.
   */
  async createWithin(
    manager: EntityManager,
    input: AgentCreate,
  ): Promise<Agent> {
    const fields = parseInput(agentCreateSchema, input);
    const agents = manager.getRepository(Agent);
    if (await agents.existsBy({ name: fields.name })) {
      throw new ConflictError(`An Agent named ${fields.name} already exists`);
    }
    const settings = await getSettings(manager);
    const provider = fields.provider ?? settings.defaultProvider;
    const workingDirectory = await ownFolder(fields.workingDirectory);
    if (workingDirectory === null) {
      // The default may have gone missing since it was set.
      await validateWorkingDirectory(
        followable({ workingDirectory }, settings),
      );
    }

    const { id } = await agents.save(
      agents.create({
        name: fields.name,
        title: fields.title ?? null,
        provider,
        providerOptions: optionsFor(
          provider,
          settings.providerDefaults[provider],
          fields.providerOptions,
        ),
        instructions: fields.instructions ?? null,
        workingDirectory,
        useSharedInstructions: fields.useSharedInstructions ?? true,
        codexSkipGitRepoCheck: fields.codexSkipGitRepoCheck ?? false,
        toolPolicy: {
          permissions: fields.permissions ?? settings.defaultPermissions,
        },
      }),
    );
    return agents.findOneByOrFail({ id });
  }

  /**
   * Changes an Agent. A new provider takes that provider's default options
   * unless options are given. Active Sessions are not touched here: the next
   * turn starts a fresh one when the provider or effective folder differs.
   */
  async edit(name: string, input: AgentEdit): Promise<Agent> {
    const patch = parseInput(agentEditSchema, input);
    return inTransaction(this.dataSource, async (manager) => {
      const agents = manager.getRepository(Agent);
      const agent = await findAgent(manager, name);
      const settings = await getSettings(manager);

      const provider = patch.provider ?? agent.provider;
      const providerChanged = provider !== agent.provider;
      const providerOptions =
        providerChanged || patch.providerOptions !== undefined
          ? optionsFor(
              provider,
              providerChanged
                ? settings.providerDefaults[provider]
                : agent.providerOptions,
              patch.providerOptions,
            )
          : agent.providerOptions;

      const workingDirectory =
        patch.workingDirectory === undefined
          ? agent.workingDirectory
          : await ownFolder(patch.workingDirectory);
      const folder = followable({ workingDirectory }, settings);
      const enabled = patch.enabled ?? agent.enabled;
      // An own folder was checked above; check the folder an Agent being
      // enabled, or returning to the default, will work in.
      if (enabled && (patch.enabled || patch.workingDirectory === null)) {
        await validateWorkingDirectory(folder);
      }

      await agents.update(agent.id, {
        ...(patch.permissions === undefined
          ? {}
          : {
              toolPolicy: {
                ...agent.toolPolicy,
                permissions: patch.permissions,
              },
            }),
        ...withoutUndefined({
          title: patch.title,
          instructions: patch.instructions,
          useSharedInstructions: patch.useSharedInstructions,
          codexSkipGitRepoCheck: patch.codexSkipGitRepoCheck,
        }),
        provider,
        providerOptions,
        workingDirectory,
        enabled,
      });
      return agents.findOneByOrFail({ id: agent.id });
    });
  }

  /** The Agent's execution settings with its folder and instructions resolved. */
  resolve(name: string): Promise<ResolvedAgent> {
    // A transaction reads the Agent and settings as one consistent snapshot.
    return inTransaction(this.dataSource, async (manager) =>
      resolveAgent(manager, await findAgent(manager, name)),
    );
  }

  /** `resolve` by ID, inside the caller's transaction. */
  async resolveWithin(
    manager: EntityManager,
    id: number,
  ): Promise<ResolvedAgent> {
    const agent = await manager.getRepository(Agent).findOneBy({ id });
    if (agent === null) throw new NotFoundError(`No Agent with ID ${id}`);
    return resolveAgent(manager, agent);
  }
}

async function resolveAgent(
  manager: EntityManager,
  agent: Agent,
): Promise<ResolvedAgent> {
  const settings = await getSettings(manager);
  return {
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    providerOptions: agent.providerOptions,
    workingDirectory: effectiveWorkingDirectory(agent, settings),
    instructions: composeInstructions(agent, settings),
    toolPolicy: agent.toolPolicy,
    codexSkipGitRepoCheck: agent.codexSkipGitRepoCheck,
    enabled: agent.enabled,
  };
}

async function findAgent(manager: EntityManager, name: string): Promise<Agent> {
  const agent = await manager
    .getRepository(Agent)
    .findOneBy({ name: name.toLowerCase() });
  if (agent === null) throw new NotFoundError(`No Agent named ${name}`);
  return agent;
}

function getSettings(manager: EntityManager): Promise<Settings> {
  return manager.getRepository(Settings).findOneByOrFail({ id: SETTINGS_ID });
}

/** Validates a folder of the Agent's own; null or omitted follows the default. */
async function ownFolder(
  folder: string | null | undefined,
): Promise<string | null> {
  return folder == null ? null : validateWorkingDirectory(folder);
}

/** The effective folder, refusing to follow a default that is unset. */
function followable(
  agent: Pick<Agent, 'workingDirectory'>,
  settings: Settings,
): string {
  if (
    agent.workingDirectory === null &&
    settings.defaultWorkingDirectory === null
  ) {
    throw new InvalidInputError(NO_DEFAULT_FOLDER);
  }
  return effectiveWorkingDirectory(agent, settings);
}

/** `base` with `patch` applied, checked against `provider`'s own options. */
function optionsFor(
  provider: Provider,
  base: object,
  patch: object | undefined,
): ProviderOptions {
  const result = PROVIDER_OPTIONS_SCHEMAS[provider].safeParse(
    mergeOptions(base, patch),
  );
  if (!result.success) {
    throw new InvalidInputError(
      `Invalid ${provider} options: ${describeIssues(result.error, 'providerOptions')}`,
    );
  }
  return result.data;
}
