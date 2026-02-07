/**
 * Provider protocol and registry.
 */

/** Configuration for a completion request. */
export interface CompletionConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  outputFormat?: 'text' | 'json';
  /** field name -> [type, description] */
  outputSchema?: Record<string, [string, string]>;
}

/** Result from a completion request. */
export interface CompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/** Protocol for model providers. */
export interface Provider {
  readonly name: string;
  complete(prompt: string, config: CompletionConfig): Promise<CompletionResult>;
}

/** Registry for model providers. */
export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();

  /** Register a provider. */
  register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  /** Get a provider by name. */
  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  /** Get provider and model name from model identifier (e.g. "anthropic/claude-sonnet-4-20250514"). */
  getForModel(modelId: string): [Provider, string] | undefined {
    if (!modelId.includes('/')) {
      return undefined;
    }
    const slashIndex = modelId.indexOf('/');
    const providerName = modelId.slice(0, slashIndex);
    const modelName = modelId.slice(slashIndex + 1);
    const provider = this.get(providerName);
    if (provider) {
      return [provider, modelName];
    }
    return undefined;
  }
}

/** Global registry. */
const _registry = new ProviderRegistry();

/** Get the global provider registry. */
export function getRegistry(): ProviderRegistry {
  return _registry;
}

/** Register a provider globally. */
export function registerProvider(provider: Provider): void {
  _registry.register(provider);
}
