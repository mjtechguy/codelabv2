# Plan: Universal Thinking/Reasoning Model Support

## Current State
The code only handles OpenAI reasoning models (o1, o3-mini, gpt-5) using `max_completion_tokens`.

## Problem
Different providers have different approaches to thinking/reasoning:

### **OpenAI** (o1, o3-mini, gpt-5)
- Uses `max_completion_tokens` instead of `max_tokens`
- Hides reasoning tokens automatically in API responses
- Current code: ✅ Already working

### **DeepSeek** (DeepSeek-R1, deepseek-reasoner)
- Uses standard `max_tokens` parameter
- Exposes both `reasoning_content` and `content` in responses
- Has optional `thinking_budget` parameter (up to 32K tokens)
- Current code: ❌ Will show reasoning tokens (not hidden)

### **Anthropic** (Claude 3.7+, Claude 4)
- Requires `thinking` object with `type: "enabled"` and `budget_tokens`
- Minimum budget: 1,024 tokens
- Returns thinking summary in response
- Current code: ❌ Won't enable thinking mode

### **Google Gemini** (2.5 Flash, 2.5 Pro)
- Uses `thinkingBudget` parameter (0-24,576 tokens)
- -1 = dynamic budget based on complexity
- Returns `thoughts_token_count` in metadata
- Current code: ❌ Won't enable thinking mode

## Proposed Solution

### 1. **Enhance ModelConfig** (types/chat.ts)
Add optional thinking configuration:
```typescript
export interface ModelConfig {
    // ... existing fields ...
    thinking?: {
        enabled: boolean;
        budget?: number;  // Token budget for thinking
    };
}
```

### 2. **Create Provider Detection** (llmClient.ts)
Expand model detection to identify provider type:
```typescript
private getModelProvider(modelName: string): 'openai' | 'deepseek' | 'anthropic' | 'gemini' | 'unknown'
private isThinkingModel(modelName: string): boolean
```

### 3. **Add Provider-Specific Logic** (llmClient.ts)
In `sendMessage()`:
- **OpenAI reasoning**: Use `max_completion_tokens` (already done)
- **DeepSeek**: Add optional `thinking_budget` parameter
- **Anthropic**: Add `thinking` object with type and budget_tokens
- **Gemini**: Add `thinkingBudget` parameter via config

### 4. **Universal Thinking Token Filter** (llmClient.ts)
Update stream handler to filter:
- `delta.reasoning_content` (DeepSeek)
- `delta.content` with `type: "thinking"` (Anthropic)
- Thinking blocks from Gemini responses

### 5. **Config Example Documentation**
Provide example configs for each provider showing thinking setup.

## Benefits
✅ Support all major thinking/reasoning models
✅ Automatically hide thinking tokens regardless of provider
✅ Optional fine-grained control via config
✅ Backward compatible (thinking disabled by default)
✅ Future-proof architecture

## Files to Modify
1. `src/types/chat.ts` - Add thinking config to ModelConfig
2. `src/chat/llmClient.ts` - Add provider detection and thinking logic
3. `README.md` or docs - Add thinking model examples

## Example Configs

### DeepSeek R1 with Thinking
```yaml
version: "1.0"
models:
  - name: "DeepSeek R1"
    provider: "deepseek"
    apiBase: "https://api.deepseek.com/v1"
    apiKey: "sk-..."
    model: "deepseek-reasoner"
    maxTokens: 8000
    thinking:
      enabled: true
      budget: 32000  # Max thinking tokens
```

### Anthropic Claude 3.7 with Extended Thinking
```yaml
version: "1.0"
models:
  - name: "Claude 3.7 Sonnet"
    provider: "anthropic"
    apiBase: "https://api.anthropic.com/v1"
    apiKey: "sk-ant-..."
    model: "claude-3-7-sonnet-20250219"
    maxTokens: 4096
    thinking:
      enabled: true
      budget: 4096  # Min 1024 tokens
```

### Google Gemini 2.5 Flash with Dynamic Thinking
```yaml
version: "1.0"
models:
  - name: "Gemini 2.5 Flash"
    provider: "google"
    apiBase: "https://generativelanguage.googleapis.com/v1beta"
    apiKey: "..."
    model: "gemini-2.5-flash"
    maxTokens: 8192
    thinking:
      enabled: true
      budget: -1  # -1 = dynamic budget
```

### OpenAI o1 (Already Working)
```yaml
version: "1.0"
models:
  - name: "GPT-5 Mini"
    provider: "openai"
    apiBase: "https://api.openai.com/v1"
    apiKey: "sk-..."
    model: "gpt-5-mini"
    maxTokens: 4096
    # No thinking config needed - automatic
```
