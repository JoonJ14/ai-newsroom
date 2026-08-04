/**
 * AI Newsroom MCP Server — Supabase Edge Function
 *
 * Implements the Model Context Protocol over HTTP transport.
 * JSON-RPC 2.0 methods: initialize, tools/list, tools/call
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { TOOLS } from './_shared/tools.ts';
import {
  handleGetTopPicks,
  handleGetTrending,
  handleSearch,
  handleGetNewSince,
  handleGetSourceUpdates,
  handleCheckStatus,
} from './_shared/handlers.ts';
import {
  handleGetRepoQuickstart,
  handleGetPaperBrief,
} from './_shared/external.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonRpcResponse(id: unknown, result: unknown) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonRpcError(null, -32600, 'Only POST requests are accepted');
  }

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error: invalid JSON');
  }

  // `null`, `[]` and `"text"` are all valid JSON, so req.json() resolves rather
  // than throwing. Destructuring null would then raise an uncaught TypeError
  // out of the request handler on a public endpoint.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonRpcError(null, -32600, 'Invalid Request: body must be a JSON-RPC object');
  }

  const { id, method, params } = body;

  // ─── initialize ─────────────────────────────────────────────
  if (method === 'initialize') {
    return jsonRpcResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'ai-newsroom',
        version: '0.1.0',
      },
    });
  }

  // ─── tools/list ─────────────────────────────────────────────
  if (method === 'tools/list') {
    return jsonRpcResponse(id, { tools: TOOLS });
  }

  // ─── tools/call ─────────────────────────────────────────────
  if (method === 'tools/call') {
    const toolName = params?.name as string;
    const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

    if (!toolName) {
      return jsonRpcError(id, -32602, 'Missing parameter: name');
    }

    // Built on demand: get_repo_quickstart and get_paper_brief resolve their
    // answer from an external API and never touch the database, so missing
    // Supabase credentials must not fail them.
    const requireSupabase = () => {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!supabaseUrl || !supabaseKey) {
        throw new Error('Server misconfigured: missing Supabase credentials');
      }
      return createClient(supabaseUrl, supabaseKey);
    };

    try {
      let result: unknown;

      switch (toolName) {
        case 'get_top_picks':
          result = await handleGetTopPicks(requireSupabase(), toolArgs);
          break;
        case 'get_trending':
          result = await handleGetTrending(requireSupabase(), toolArgs);
          break;
        case 'search':
          result = await handleSearch(requireSupabase(), toolArgs);
          break;
        case 'get_new_since':
          result = await handleGetNewSince(requireSupabase(), toolArgs);
          break;
        case 'get_source_updates':
          result = await handleGetSourceUpdates(requireSupabase(), toolArgs);
          break;
        case 'get_repo_quickstart':
          result = await handleGetRepoQuickstart(toolArgs);
          break;
        case 'get_paper_brief':
          result = await handleGetPaperBrief(toolArgs);
          break;
        case 'check_status':
          result = await handleCheckStatus(requireSupabase());
          break;
        default:
          return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
      }

      return jsonRpcResponse(id, {
        content: [result],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Caller-fault messages map to -32602 (invalid params). Returning -32603
      // for these tells the client the server broke, so it retries a request
      // that can never succeed.
      const isCallerFault =
        /^(Missing required parameter|Invalid repo|Invalid arxiv_id)\b/.test(message) ||
        /^(Repo not found|No ArXiv paper found)\b/.test(message);
      return jsonRpcError(id, isCallerFault ? -32602 : -32603, message);
    }
  }

  // ─── Unknown method ─────────────────────────────────────────
  return jsonRpcError(id, -32601, `Unknown method: ${method}`);
});
