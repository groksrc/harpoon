/**
 * Anthropic Claude provider.
 */

import { ProviderError } from '../errors.js';
import type { CompletionConfig, CompletionResult, Provider } from './base.js';

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private baseUrl: string;
  private apiVersion = '2023-06-01';

  constructor() {
    this.baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  }

  private getApiKey(): string {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new ProviderError('ANTHROPIC_API_KEY environment variable not set', false);
    }
    return key;
  }

  private buildSchemaTool(
    schema: Record<string, [string, string]>,
  ): Record<string, unknown> {
    const properties: Record<string, Record<string, string>> = {};
    const required: string[] = [];

    for (const [fieldName, [fieldType, fieldDesc]] of Object.entries(schema)) {
      const typeMap: Record<string, string> = {
        string: 'string',
        number: 'number',
        boolean: 'boolean',
        array: 'array',
        object: 'object',
      };
      const jsonType = typeMap[fieldType] ?? 'string';

      properties[fieldName] = {
        type: jsonType,
        description: fieldDesc || `The ${fieldName} field`,
      };
      required.push(fieldName);
    }

    return {
      name: 'structured_output',
      description: 'Return structured output',
      input_schema: {
        type: 'object',
        properties,
        required,
      },
    };
  }

  async complete(prompt: string, config: CompletionConfig): Promise<CompletionResult> {
    const apiKey = this.getApiKey();

    const messages = [{ role: 'user', content: prompt }];

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: config.maxTokens ?? 4096,
    };

    if (config.temperature !== undefined) {
      body.temperature = config.temperature;
    }

    // For JSON output, use tool_use to force structured response
    if (config.outputFormat === 'json' && config.outputSchema) {
      const tool = this.buildSchemaTool(config.outputSchema);
      body.tools = [tool];
      body.tool_choice = { type: 'tool', name: 'structured_output' };
    }

    return this.makeRequest(body, apiKey, config.outputFormat === 'json');
  }

  private async makeRequest(
    body: Record<string, unknown>,
    apiKey: string,
    isJson: boolean,
  ): Promise<CompletionResult> {
    const url = `${this.baseUrl}/v1/messages`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': this.apiVersion,
    };

    const delays = [1000, 2000, 4000]; // Retry delays in milliseconds

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          const status = response.status;

          // Non-retryable errors
          if ([400, 401, 403, 404].includes(status)) {
            throw new ProviderError(
              `Anthropic API error ${status}: ${errorBody}`,
              false,
            );
          }

          // Retryable errors
          if ([429, 500, 502, 503, 504].includes(status)) {
            if (attempt < 3) {
              await sleep(delays[attempt]);
              continue;
            }
            throw new ProviderError(
              `Anthropic API error ${status} after retries: ${errorBody}`,
              true,
            );
          }

          throw new ProviderError(
            `Anthropic API error ${status}: ${errorBody}`,
            false,
          );
        }

        const result = (await response.json()) as Record<string, unknown>;
        return this.parseResponse(result, isJson);
      } catch (err) {
        if (err instanceof ProviderError) throw err;

        // Network or timeout errors
        if (attempt < 3) {
          await sleep(delays[attempt]);
          continue;
        }

        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw new ProviderError('Request timed out after retries', true);
        }
        throw new ProviderError(`Network error: ${err}`, true);
      }
    }

    throw new ProviderError('Max retries exceeded', true);
  }

  private parseResponse(
    result: Record<string, unknown>,
    _isJson: boolean,
  ): CompletionResult {
    let content = '';

    const contentBlocks = result.content as Array<Record<string, unknown>> | undefined;
    if (contentBlocks) {
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          content = (block.text as string) ?? '';
          break;
        } else if (block.type === 'tool_use') {
          // For structured output, return the tool input as JSON
          content = JSON.stringify(block.input ?? {});
          break;
        }
      }
    }

    const usage = (result.usage as Record<string, number>) ?? {};
    return {
      content,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
