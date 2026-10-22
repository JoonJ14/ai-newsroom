/**
 * The guard on why-lines that describe coverage instead of news. The code lives in supabase/functions/_shared/newsroom/why.ts,
 * shared with the MCP server (Deno), so there is one copy; this re-export
 * keeps Node's imports where they were.
 */

export * from '../../supabase/functions/_shared/newsroom/why.ts';
