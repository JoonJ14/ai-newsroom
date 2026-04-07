/**
 * AI relevance keyword filter.
 * Returns true if the item's title or summary matches at least one AI keyword.
 */

import type { NewsItem } from '../collectors/types.js';

const AI_KEYWORDS = [
  'ai', 'artificial intelligence', 'llm', 'gpt', 'claude', 'anthropic',
  'openai', 'gemini', 'deepmind', 'google ai', 'machine learning',
  'deep learning', 'neural network', 'transformer', 'agent', 'mcp',
  'model context protocol', 'inference', 'fine-tune', 'fine-tuning',
  'embedding', 'rag', 'retrieval augmented', 'diffusion', 'computer vision',
  'nlp', 'natural language', 'chatbot', 'copilot', 'cursor', 'codex',
  'coding agent', 'vibe coding', 'prompt engineering', 'token',
  'context window', 'multimodal', 'text-to-image', 'text-to-video',
  'stable diffusion', 'midjourney', 'hugging face', 'huggingface', 'arxiv',
  'benchmark', 'open source ai', 'nvidia', 'cuda', 'tensorrt',
  'gpu computing', 'gesture recognition', 'pose estimation', 'mediapipe',
];

// Pre-compile regex patterns for each keyword (word boundary or common substring match)
const KEYWORD_PATTERNS = AI_KEYWORDS.map((kw) => {
  // Escape regex special chars
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Use word boundary for single words, looser match for multi-word phrases
  return new RegExp(`\\b${escaped}\\b`, 'i');
});

export function isAIRelevant(item: NewsItem): boolean {
  const text = `${item.title} ${item.summary ?? ''}`.toLowerCase();

  for (const pattern of KEYWORD_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  return false;
}
