/**
 * aiClient.js — Multi-provider LLM routing client for LibreLog BYOK AI features.
 * Supports OpenAI, Anthropic, and local Ollama. API keys stored in IndexedDB settings.
 * All public functions return error objects on failure — never throw.
 */

import { getSetting, setSetting } from '../data/db.js';

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/**
 * Check whether AI is configured (provider set, key present for cloud providers).
 * @returns {Promise<boolean>}
 */
export async function isAIConfigured() {
    const provider = await getSetting('ai_provider', null);
    if (!provider) return false;
    if (provider === 'ollama') return true;
    const apiKey = await getSetting('ai_api_key', null);
    return Boolean(apiKey);
}

/**
 * Read all AI-related settings from IndexedDB.
 * @returns {Promise<{provider: string|null, apiKey: string|null, model: string|null, ollamaUrl: string}>}
 */
export async function getAIConfig() {
    const [provider, apiKey, model, ollamaUrl] = await Promise.all([
        getSetting('ai_provider', null),
        getSetting('ai_api_key', null),
        getSetting('ai_model', null),
        getSetting('ai_ollama_url', 'http://localhost:11434'),
    ]);
    return { provider, apiKey, model, ollamaUrl };
}

// ---------------------------------------------------------------------------
// Provider-specific helpers
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Perform a fetch with a 15-second abort timeout.
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Route a chat completion request to OpenAI.
 */
async function openaiCompletion(messages, { apiKey, model, maxTokens, temperature, jsonMode }) {
    const body = {
        model: model || 'gpt-4o',
        messages,
        max_tokens: maxTokens,
        temperature,
    };
    if (jsonMode) {
        body.response_format = { type: 'json_object' };
    }

    const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`OpenAI ${res.status}: ${text}`);
    }

    const data = await res.json();
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
async function anthropicCompletion(messages, { apiKey, model, maxTokens, temperature }) {
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

    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Anthropic ${res.status}: ${text}`);
    }

    const data = await res.json();
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
async function ollamaCompletion(messages, { model, ollamaUrl }) {
    const body = {
        model: model || 'llama3',
        messages,
        stream: false,
    };

    const res = await fetchWithTimeout(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Ollama ${res.status}: ${text}`);
    }

    const data = await res.json();
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
 * @returns {Promise<{content: string|null, usage?: Object, error?: string}>}
 */
export async function chatCompletion(messages, options = {}) {
    const { maxTokens = 1024, temperature = 0.3, jsonMode = false } = options;

    try {
        const config = await getAIConfig();
        const { provider, apiKey, model, ollamaUrl } = config;

        if (!provider) {
            return { content: null, error: 'No AI provider configured' };
        }
        if (provider !== 'ollama' && !apiKey) {
            return { content: null, error: `API key not set for provider "${provider}"` };
        }

        const params = { apiKey, model, maxTokens, temperature, jsonMode, ollamaUrl };

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

        return result;
    } catch (err) {
        const message = err.name === 'AbortError'
            ? 'AI request timed out (15 s)'
            : err.message || String(err);
        console.warn('[aiClient] chatCompletion failed:', message);
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
export async function logUsage(provider, tokens, estimatedCost) {
    try {
        const log = (await getSetting('ai_usage_log', [])).slice();
        log.push({
            date: new Date().toISOString(),
            provider,
            tokens,
            cost: estimatedCost,
        });
        // Keep only the most recent 100 entries
        while (log.length > 100) log.shift();
        await setSetting('ai_usage_log', log);
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
    const log = await getSetting('ai_usage_log', []);

    let totalCost = 0;
    let totalTokens = 0;
    let monthCost = 0;
    let entriesThisMonth = 0;

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    for (const entry of log) {
        totalCost += entry.cost ?? 0;
        totalTokens += entry.tokens ?? 0;

        const d = new Date(entry.date);
        if (d.getMonth() === currentMonth && d.getFullYear() === currentYear) {
            entriesThisMonth++;
            monthCost += entry.cost ?? 0;
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
