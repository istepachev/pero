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
import { SLUG_MAX_LENGTH } from '../config/slug.js';
import { validateWorkingDirectory } from '../config/working-directory.js';
import {
  agentDefinition,
  defaultsOf,
  SqliteDefinitions,
} from '../definitions/sqlite-definitions.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import {
  SETTINGS_ID,
  Settings,
} from '../persistence/entities/settings.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import {
  effectiveWorkingDirectory,
  type ResolvedAgent,
  resolveAgent,
} from './agent-resolution.js';

const NO_DEFAULT_FOLDER =
  'No default working directory is set: give the Agent its own folder, ' +
  'or set the default working directory first';

/** Why onboarding can't create an Agent yet. */
const UNSET_DEFAULT_FOLDER = 'No default working directory is set';

/** The Agent primary Channels get while the `main-agent` setting is unset. */
export const MAIN_AGENT_NAME = 'main';

/**
 * Creates and edits Agent definitions. Runtime code reads them through
 * `Definitions`; the reads here serve the CLI's edits and tests.
 */
@Injectable()
export class AgentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: SqliteDefinitions,
  ) {}

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
  async create(input: AgentCreate): Promise<Agent> {
    const agent = await inTransaction(this.dataSource, (manager) =>
      this.createWithin(manager, input),
    );
    this.committed();
    return agent;
  }

  /**
   * `create` inside the caller's transaction, so the Agent commits or rolls
   * back with whatever else the caller writes there. The caller calls
   * `committed` once it has.
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
    const edited = await inTransaction(this.dataSource, async (manager) => {
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
    this.committed();
    return edited;
  }

  /**
   * Inside the caller's transaction: the main Agent, which primary
   * Channels get. While none is chosen, an Agent named `main` becomes it,
   * created first when there is none.
   */
  async mainAgentWithin(manager: EntityManager): Promise<Agent> {
    const settings = await getSettings(manager);
    const agents = manager.getRepository(Agent);
    if (settings.mainAgentId !== null) {
      return agents.findOneByOrFail({ id: settings.mainAgentId });
    }
    // An Agent the owner already named `main` becomes the main Agent.
    const agent =
      (await agents.findOneBy({ name: MAIN_AGENT_NAME })) ??
      (await this.createFollowingWithin(manager, settings, {
        name: MAIN_AGENT_NAME,
      }));
    await manager
      .getRepository(Settings)
      .update(SETTINGS_ID, { mainAgentId: agent.id });
    return agent;
  }

  /**
   * Inside the caller's transaction: a new Agent for a topic, named `base`
   * or, when that is taken, `base-2`, `base-3`, …, with the installation
   * defaults. `InvalidInputError` while no default folder is set.
   */
  async createForTopicWithin(
    manager: EntityManager,
    { base, title }: { base: string; title: string | null },
  ): Promise<Agent> {
    return this.createFollowingWithin(manager, await getSettings(manager), {
      name: await uniqueName(manager, base),
      title,
    });
  }

  /**
   * Inside the caller's transaction: retitles Agent `id` to `title` while
   * its title still mirrors its topic's, `topicTitle`; never its name.
   */
  async retitleWithin(
    manager: EntityManager,
    id: number,
    topicTitle: string | null,
    title: string | null,
  ): Promise<void> {
    const agents = manager.getRepository(Agent);
    const agent = await agents.findOneByOrFail({ id });
    if (agent.title === topicTitle) await agents.update(id, { title });
  }

  /** Tells readers of the definitions that Agents written here committed. */
  committed(): void {
    this.definitions.changed();
  }

  /** An Agent that follows the default folder, which must be set. */
  private createFollowingWithin(
    manager: EntityManager,
    settings: Settings,
    fields: { name: string; title?: string | null },
  ): Promise<Agent> {
    if (settings.defaultWorkingDirectory === null) {
      throw new InvalidInputError(UNSET_DEFAULT_FOLDER);
    }
    return this.createWithin(manager, fields);
  }

  /** The Agent's execution settings with its folder and instructions resolved. */
  resolve(name: string): Promise<ResolvedAgent> {
    // A transaction reads the Agent and settings as one consistent snapshot.
    return inTransaction(this.dataSource, async (manager) =>
      resolveRow(manager, await findAgent(manager, name)),
    );
  }
}

async function resolveRow(
  manager: EntityManager,
  agent: Agent,
): Promise<ResolvedAgent> {
  const settings = await getSettings(manager);
  return resolveAgent(
    agent.id,
    agentDefinition(agent, settings),
    defaultsOf(settings),
  );
}

/** The Agent named `name`, in any case; `NotFoundError` otherwise. */
export async function findAgent(
  manager: EntityManager,
  name: string,
): Promise<Agent> {
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

/** `base`, or `base-2`, `base-3`, … when taken, cut to fit a slug. */
async function uniqueName(
  manager: EntityManager,
  base: string,
): Promise<string> {
  const agents = manager.getRepository(Agent);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const stem = base
      .slice(0, SLUG_MAX_LENGTH - suffix.length)
      .replace(/-$/, '');
    const name = stem + suffix;
    if (!(await agents.existsBy({ name }))) return name;
  }
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
