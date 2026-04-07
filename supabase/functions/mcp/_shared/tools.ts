/**
 * MCP Tool definitions — names, descriptions, and JSON Schema input parameters.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_top_picks',
    description:
      'Get the latest AI news organized by category: official announcements, community highlights, research papers, and industry news. Uses a smart slots-based layout that guarantees diversity across sources.',
    inputSchema: {
      type: 'object',
      properties: {
        officialLimit: {
          type: 'number',
          description: 'Max official announcement items (default 15)',
        },
        communityLimit: {
          type: 'number',
          description: 'Max community items (default 5)',
        },
        researchLimit: {
          type: 'number',
          description: 'Max research items (default 3)',
        },
        industryLimit: {
          type: 'number',
          description: 'Max industry items (default 2)',
        },
        showAll: {
          type: 'boolean',
          description: 'If true, remove all caps and show everything',
        },
      },
    },
  },
  {
    name: 'get_trending',
    description:
      'Get all cached news items, optionally filtered by source or category.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'Filter by source ID (e.g., "anthropic_blog", "reddit_claudeai")',
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
    description: 'Search AI news by keyword across titles and summaries.',
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
      },
      required: ['query'],
    },
  },
  {
    name: 'get_new_since',
    description:
      "Get all items added after a specific time. Perfect for 'what's new since yesterday?' or 'what did I miss this weekend?'",
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
          description: 'Max items to return (default 50)',
        },
      },
      required: ['since'],
    },
  },
  {
    name: 'get_source_updates',
    description: 'Get the latest items from a specific source.',
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
      },
      required: ['source'],
    },
  },
  {
    name: 'check_status',
    description:
      'Check the health of the news cache: when it was last updated, total items, and per-source breakdown.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
