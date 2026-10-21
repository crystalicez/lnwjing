import type { McpToolDefinition } from './tools/tool-types.js';

export interface LnwjingPluginPermission {
  readonly name: string;
  readonly reason: string;
}

export interface LnwjingSkillDescriptor {
  readonly id: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface LnwjingRecipeDescriptor {
  readonly name: string;
  readonly steps: readonly string[];
}

export interface LnwjingPlugin {
  readonly id: string;
  readonly version: string;
  readonly tools?: readonly McpToolDefinition[];
  readonly hooks?: readonly string[];
  readonly skills?: readonly LnwjingSkillDescriptor[];
  readonly recipes?: readonly LnwjingRecipeDescriptor[];
  readonly requiredPermissions?: readonly LnwjingPluginPermission[];
}
