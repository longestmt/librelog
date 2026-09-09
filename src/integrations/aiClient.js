/**
 * aiClient.js — Multi-provider LLM routing client for LibreLog BYOK AI features.
 * Supports OpenAI, Anthropic, and local Ollama. API keys stored in IndexedDB settings.
 * All public functions return error objects on failure — never throw.
 */

import { getSetting, setSetting } from '../data/db.js';
import { getCredential } from '../data/credentials.js';
import { hasRemoteProviderConsent } from './privacy.js';
import { withAISettingsLock } from './ai-settings.js';
import {
    assertDataMutationGenerationCurrent,
    captureDataMutationGeneration,
    withDataLifecycleLock,
} from '../data/operation-locks.js';
import { convertMessagesForOllama, normalizeOllamaUrl } from './ollama.js';
import {
    getSafeIntegrationMessage,
    logIntegrationFailure,
    requestJSON,
} from './request.js';

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/**
 * Check whether AI is configured (provider set, key present for cloud providers).
 * @returns {Promise<boolean>}
 */
export async function isAIConfigured() {
    const config = await getAIConfig();
    const { provider } = config;
    if (!provider) return false;
    if (provider === 'ollama') {
        const { model, ollamaUrl } = config;
        if (typeof model !== 'string' || !model.trim()) return false;
        try {
            normalizeOllamaUrl(ollamaUrl);
            return true;
        } catch {
            return false;
        }
    }
    const hasConsent = await hasRemoteProviderConsent(`ai_${provider}`);
    return Boolean(
        config.apiKey
        && config.apiKeyProvider === provider
        && hasConsent,
    );
}

/**
 * Read all AI-related settings from IndexedDB.
 * @returns {Promise<{provider: string|null, apiKey: string|null, apiKeyProvider: string|null, model: string|null, ollamaUrl: string}>}
 */
export async function getAIConfig() {
    return withDataLifecycleLock(() => withAISettingsLock(async () => {
        const [provider, apiKey, apiKeyProvider, model, ollamaUrl] = await Promise.all([
            getSetting('ai_provider', null),
            getCredential('aiApiKey'),
            getSetting('ai_api_key_provider', null),
            getSetting('ai_model', null),
            getSetting('ai_ollama_url', 'http://localhost:11434'),
        ]);
        return { provider, apiKey, apiKeyProvider, model, ollamaUrl };
    }));
}

// ---------------------------------------------------------------------------
// Provider-specific helpers
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Route a chat completion request to OpenAI.
 */
async function openaiCompletion(messages, { apiKey, model, maxTokens, temperature, jsonMode, signal }) {
    const body = {
        model: model || 'gpt-4o',
        messages,
        max_tokens: maxTokens,
        temperature,
    };
    if (jsonMode) {
        body.response_format = { type: 'json_object' };
    }

    const { data } = await requestJSON({
        provider: 'OpenAI',
        consentKey: 'ai_openai',
        url: 'https://api.openai.com/v1/chat/completions',
        init: {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        },
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const choice = data.choices?.[0];
    const usage = data.usage || {};
    return {
        content: choice?.message?.content ?? null,
        usage: {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
        },
    };
}

/**
 * Convert OpenAI-style messages to Anthropic format.
 * System messages are extracted into a separate `system` string.
 * Image content blocks are converted from data-URL to base64 source objects.
 */
function convertMessagesForAnthropic(messages) {
    let system = '';
    const converted = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            system += (system ? '\n' : '') + msg.content;
            continue;
        }

        // Handle multimodal content arrays
        if (Array.isArray(msg.content)) {
            const blocks = msg.content.map((part) => {
                if (part.type === 'image_url' && part.image_url?.url) {
                    const url = part.image_url.url;
                    // Expect data URLs like "data:image/png;base64,..."
                    const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/s);
                    if (match) {
                        return {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: match[1],
                                data: match[2],
                            },
                        };
                    }
                    // Non-data URLs are not supported by Anthropic image blocks
                    return { type: 'text', text: `[image: ${url}]` };
                }
                if (part.type === 'text') {
                    return { type: 'text', text: part.text };
                }
                return part;
            });
            converted.push({ role: msg.role, content: blocks });
        } else {
            converted.push({ role: msg.role, content: msg.content });
        }
    }

    return { system, messages: converted };
}

/**
 * Route a chat completion request to Anthropic.
 */
async function anthropicCompletion(messages, { apiKey, model, maxTokens, temperature, signal }) {
    const { system, messages: anthropicMessages } = convertMessagesForAnthropic(messages);

    const body = {
        model: model || 'claude-sonnet-4-5-20250929',
        max_tokens: maxTokens,
        messages: anthropicMessages,
        temperature,
    };
    if (system) {
        body.system = system;
    }

    const { data } = await requestJSON({
        provider: 'Anthropic',
        consentKey: 'ai_anthropic',
        url: 'https://api.anthropic.com/v1/messages',
        init: {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        },
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const content = data.content?.map((b) => b.text).join('') ?? null;
    const usage = data.usage || {};
    return {
        content,
        usage: {
            promptTokens: usage.input_tokens ?? 0,
            completionTokens: usage.output_tokens ?? 0,
            totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        },
    };
}

/**
 * Route a chat completion request to a local Ollama instance.
 */
async function ollamaCompletion(messages, { model, ollamaUrl, jsonMode, signal }) {
    if (typeof model !== 'string' || !model.trim()) {
        throw new Error('Choose an installed Ollama model in Settings');
    }
    const baseUrl = normalizeOllamaUrl(ollamaUrl);
    const body = {
        model,
        messages: convertMessagesForOllama(messages),
        stream: false,
    };
    if (jsonMode) body.format = 'json';

    const { data } = await requestJSON({
        provider: 'Ollama',
        url: `${baseUrl}/api/chat`,
        init: {
            method: 'POST',
            redirect: 'error',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const content = data.message?.content ?? null;

    // Ollama doesn't always report token usage — estimate from content length
    const estimatedTokens = content ? Math.ceil(content.length / 4) : 0;
    return {
        content,
        usage: {
            promptTokens: data.prompt_eval_count ?? 0,
            completionTokens: data.eval_count ?? estimatedTokens,
            totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? estimatedTokens),
        },
    };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Send a chat completion to the configured AI provider.
 *
 * @param {Array<{role: string, content: string|Array}>} messages
 * @param {Object} [options]
 * @param {number} [options.maxTokens=1024]
 * @param {number} [options.temperature=0.3]
 * @param {boolean} [options.jsonMode=false]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{content: string|null, usage?: Object, error?: string}>}
 */
export async function chatCompletion(messages, options = {}) {
    const {
        maxTokens = 1024,
        temperature = 0.3,
        jsonMode = false,
        signal = null,
        mutationGeneration = captureDataMutationGeneration(),
    } = options;

    try {
        assertDataMutationGenerationCurrent(mutationGeneration);
        const config = await getAIConfig();
        const { provider, apiKey, apiKeyProvider, model, ollamaUrl } = config;

        if (!provider) {
            return { content: null, error: 'No AI provider configured' };
        }
        if (provider !== 'ollama' && !apiKey) {
            return { content: null, error: `API key not set for provider "${provider}"` };
        }
        if (provider !== 'ollama' && apiKeyProvider !== provider) {
            return { content: null, error: `Enter an API key for provider "${provider}" in Settings` };
        }
        let validatedOllamaUrl = ollamaUrl;
        let validatedModel = model;
        if (provider === 'ollama') {
            if (typeof model !== 'string' || !model.trim()) {
                return { content: null, error: 'Choose an installed Ollama model in Settings' };
            }
            validatedModel = model.trim();
            try {
                validatedOllamaUrl = normalizeOllamaUrl(ollamaUrl);
            } catch {
                return {
                    content: null,
                    error: 'Ollama must use a loopback URL configured in Settings.',
                };
            }
        }

        const params = {
            apiKey,
            model: validatedModel,
            maxTokens,
            temperature,
            jsonMode,
            ollamaUrl: validatedOllamaUrl,
            signal,
        };

        let result;
        switch (provider) {
            case 'openai':
                result = await openaiCompletion(messages, params);
                break;
            case 'anthropic':
                result = await anthropicCompletion(messages, params);
                break;
            case 'ollama':
                result = await ollamaCompletion(messages, params);
                break;
            default:
                return { content: null, error: `Unknown AI provider: ${provider}` };
        }

        return { ...result, mutationGeneration };
    } catch (err) {
        const message = getSafeIntegrationMessage(err, 'AI request failed.');
        logIntegrationFailure(err);
        return { content: null, error: message };
    }
}

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

/**
 * Append a usage entry to the ai_usage_log setting. Keeps the last 100 entries.
 *
 * @param {string} provider
 * @param {number} tokens
 * @param {number} estimatedCost
 * @returns {Promise<void>}
 */
export async function logUsage(provider, tokens, estimatedCost, { mutationGeneration } = {}) {
    try {
        const storedLog = await getSetting('ai_usage_log', []);
        const log = Array.isArray(storedLog)
            ? storedLog.filter(entry => entry && typeof entry === 'object').slice()
            : [];
        log.push({
            date: new Date().toISOString(),
            provider,
            tokens,
            cost: estimatedCost,
        });
        // Keep only the most recent 100 entries
        while (log.length > 100) log.shift();
        await setSetting('ai_usage_log', log, { mutationGeneration });
    } catch (err) {
        console.warn('[aiClient] logUsage failed:', err.message || err);
    }
}

/**
 * Compute aggregate usage statistics from the stored log.
 *
 * @returns {Promise<{totalCost: number, totalTokens: number, entriesThisMonth: number, estimatedMonthlyCost: number}>}
 */
export async function getUsageStats() {
    const storedLog = await getSetting('ai_usage_log', []);
    const log = Array.isArray(storedLog)
        ? storedLog.filter(entry => entry && typeof entry === 'object')
        : [];

    let totalCost = 0;
    let totalTokens = 0;
    let monthCost = 0;
    let entriesThisMonth = 0;

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    for (const entry of log) {
        const cost = typeof entry.cost === 'number' && Number.isFinite(entry.cost) && entry.cost >= 0
            ? entry.cost
            : 0;
        const tokens = typeof entry.tokens === 'number' && Number.isFinite(entry.tokens) && entry.tokens >= 0
            ? entry.tokens
            : 0;
        totalCost += cost;
        totalTokens += tokens;

        const d = new Date(entry.date);
        if (d.getMonth() === currentMonth && d.getFullYear() === currentYear) {
            entriesThisMonth++;
            monthCost += cost;
        }
    }

    // Estimate monthly cost by extrapolating current spend across the month
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const estimatedMonthlyCost = dayOfMonth > 0
        ? (monthCost / dayOfMonth) * daysInMonth
        : 0;

    return { totalCost, totalTokens, entriesThisMonth, estimatedMonthlyCost };
}
