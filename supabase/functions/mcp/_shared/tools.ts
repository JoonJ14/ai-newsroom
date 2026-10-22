/**
 * MCP Tool definitions — names, descriptions, and JSON Schema input parameters.
 *
 * Every parameter a tool has ever had still works; new ones are optional.
 */

import { AUDIENCES, EDITOR_TYPES } from '../../_shared/newsroom/types.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What every news item or story in a response carries, for the descriptions. */
const ENTRY_FIELDS =
  'Each entry is one story: the AI editor\'s plain `headline`, `why` it matters, `importance` (1-10), `type`, ' +
  '`audience` (general or builder), `story_key`, `followup`, every outlet that carried it (`outlets`, Hacker News ' +
  'links as "Publisher (via HN)"), the representative `url` and `published_at`, plus the original `title`, ' +
  '`source` and `score`. Editor fields are null for items not rated yet.';

/** The AI editor's filters, on the tools that list news. */
const EDITOR_FILTERS = {
  min_importance: {
    type: 'integer',
    minimum: 1,
    maximum: 10,
    description: 'Only stories the AI editor rated at least this important (1-10). 7+ is significant news, 9-10 is rare.',
  },
  type: {
    type: 'string',
    enum: [...EDITOR_TYPES],
    description: 'Only stories of this type, as judged by the AI editor.',
  },
  audience: {
    type: 'string',
    enum: [...AUDIENCES],
    description: '"general" for news anyone following AI wants; "builder" for developer tools, SDKs, tutorials.',
  },
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_top_picks',
    description:
      'Get the top AI news of the last 24 hours (or a window you choose), as the AI Newsroom morning digest ranks it: ' +
      'stories grouped across outlets and judged by an AI editor, in four sections. (1) Top stories: the most ' +
      'important news, rated 6+. (2) Also notable: rated 4+. (3) For builders: developer tools and releases. ' +
      '(4) Paper of note: at most one notable paper. Present the sections separately, each story with its headline, ' +
      'why it matters and its outlets. ' + ENTRY_FIELDS + ' If most of the window is not rated yet, the response says ' +
      'so in `note` and falls back to an older score-based ranking (mode "fallback").',
    inputSchema: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          description: 'Look back this many hours (default 24)',
        },
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp: the window starts here instead (overrides hours)',
        },
        officialLimit: {
          type: 'number',
          description: 'Older ranking only (when most items are unrated): max official announcement items',
        },
        communityLimit: {
          type: 'number',
          description: 'Older ranking only: max community items',
        },
        researchLimit: {
          type: 'number',
          description: 'Older ranking only: max research items',
        },
        industryLimit: {
          type: 'number',
          description: 'Older ranking only: max industry items',
        },
        showAll: {
          type: 'boolean',
          description: 'If true, no per-section or per-outlet limits: every story that qualifies for a section',
        },
      },
    },
  },
  {
    name: 'get_trending',
    description:
      'Get recent AI news (the last 7 days by default), most important first, optionally filtered by source, ' +
      'category, or the AI editor\'s importance, type and audience. ' + ENTRY_FIELDS,
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp: only items collected after this (default: 7 days ago)',
        },
        ...EDITOR_FILTERS,
        source: {
          type: 'string',
          description:
            'Filter by source ID (e.g., "anthropic_blog", "techcrunch_ai")',
        },
        category: {
          type: 'string',
          description:
            'Filter by category ("company_blog", "community", "research", "github", "industry_news")',
        },
        limit: {
          type: 'number',
          description: 'Max items to return (default 50)',
        },
      },
    },
  },
  {
    name: 'search',
    description:
      'Search AI news by keyword across titles, the AI editor\'s headlines and summaries. Results are grouped into ' +
      'stories, most important first. ' + ENTRY_FIELDS,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords',
        },
        since: {
          type: 'string',
          description:
            'ISO 8601 timestamp — only return items after this time',
        },
        limit: {
          type: 'number',
          description: 'Max stories to return (default 30)',
        },
        ...EDITOR_FILTERS,
      },
      required: ['query'],
    },
  },
  {
    name: 'get_new_since',
    description:
      "Get everything collected after a specific time, grouped into stories, most important first. Perfect for " +
      "'what's new since yesterday?' or 'what did I miss this weekend?' " + ENTRY_FIELDS,
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description:
            'ISO 8601 timestamp (e.g., "2026-04-05T00:00:00Z")',
        },
        limit: {
          type: 'number',
          description: 'Max stories to return (default 50)',
        },
        ...EDITOR_FILTERS,
      },
      required: ['since'],
    },
  },
  {
    name: 'get_source_updates',
    description:
      'Get the latest items from a specific source, the most important of its recent items first. ' + ENTRY_FIELDS,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'Source ID (e.g., "anthropic_blog", "claude_code_releases")',
        },
        limit: {
          type: 'number',
          description: 'Max items to return (default 20)',
        },
        ...EDITOR_FILTERS,
      },
      required: ['source'],
    },
  },
  {
    name: 'get_repo_quickstart',
    description:
      'Look up a GitHub repo and return its metadata (stars, language, license, last push) plus the install/usage section pulled out of its README. Use this when the user asks how to get started with, install, or try out a repo they saw in the news.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description:
            'Repo as "owner/name" (e.g. "anthropics/claude-code"). A github.com URL also works.',
        },
      },
      required: ['repo'],
    },
  },
  {
    name: 'get_paper_brief',
    description:
      'Fetch an ArXiv paper by ID and return its title, authors, abstract, categories, and links. Use this when the user asks what a paper is about after seeing it in the research section.',
    inputSchema: {
      type: 'object',
      properties: {
        arxiv_id: {
          type: 'string',
          description:
            'ArXiv identifier (e.g. "2501.12345" or "2501.12345v2"). An arxiv.org abs/pdf URL also works.',
        },
      },
      required: ['arxiv_id'],
    },
  },
  {
    name: 'check_status',
    description:
      'Check the health of the news cache: when it was last updated, total items, per-source breakdown, how much of ' +
      'the last 24 hours the AI editor has rated (share judged, newest judgment, rubric versions), and which commit ' +
      'of the server is deployed.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
