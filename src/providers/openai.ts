/**
 * OpenAI provider.
 */

import { ProviderError } from '../errors.js';
import type { CompletionConfig, CompletionResult, Provider } from './base.js';

export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com';
  }

  private getApiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new ProviderError('OPENAI_API_KEY environment variable not set', false);
    }
    return key;
  }

  private buildJsonSchema(
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
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
  }

  async complete(prompt: string, config: CompletionConfig): Promise<CompletionResult> {
    const apiKey = this.getApiKey();

    const messages = [{ role: 'user', content: prompt }];

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
    };

    if (config.maxTokens) {
      body.max_tokens = config.maxTokens;
    }

    if (config.temperature !== undefined) {
      body.temperature = config.temperature;
    }

    // For JSON output, use response_format
    if (config.outputFormat === 'json') {
      if (config.outputSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            strict: true,
            schema: this.buildJsonSchema(config.outputSchema),
          },
        };
      } else {
        body.response_format = { type: 'json_object' };
      }
    }

    return this.makeRequest(body, apiKey);
  }

  private async makeRequest(
    body: Record<string, unknown>,
    apiKey: string,
  ): Promise<CompletionResult> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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
              `OpenAI API error ${status}: ${errorBody}`,
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
              `OpenAI API error ${status} after retries: ${errorBody}`,
              true,
            );
          }

          throw new ProviderError(
            `OpenAI API error ${status}: ${errorBody}`,
            false,
          );
        }

        const result = (await response.json()) as Record<string, unknown>;
        return this.parseResponse(result);
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

  private parseResponse(result: Record<string, unknown>): CompletionResult {
    const choices = (result.choices as Array<Record<string, unknown>>) ?? [];
    let content = '';
    if (choices.length > 0) {
      const message = (choices[0].message as Record<string, unknown>) ?? {};
      content = (message.content as string) ?? '';
    }

    const usage = (result.usage as Record<string, number>) ?? {};
    return {
      content,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
