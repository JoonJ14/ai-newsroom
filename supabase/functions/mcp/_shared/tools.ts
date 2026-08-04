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
      'Get the latest AI news organized into 5 sections. IMPORTANT: Always display ALL sections as distinct categories in your response. The sections are: (1) Today\'s Highlights — items published in the last 24 hours, (2) Official Announcements — company blog posts and major releases, (3) Community Highlights — Reddit, HackerNews, HuggingFace, (4) Research & Papers — ArXiv and academic work, (5) Industry News — trade publications and analysis. Each section has its own emoji and label. Present them separately — do not merge Today\'s Highlights into other sections.',
    inputSchema: {
      type: 'object',
      properties: {
        officialLimit: {
          type: 'number',
          description: 'Max official announcement items (default 10)',
        },
        communityLimit: {
          type: 'number',
          description: 'Max community items (default 8)',
        },
        researchLimit: {
          type: 'number',
          description: 'Max research items (default 6)',
        },
        industryLimit: {
          type: 'number',
          description: 'Max industry items (default 4)',
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
      'Check the health of the news cache: when it was last updated, total items, and per-source breakdown.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
