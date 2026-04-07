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

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      return jsonRpcError(id, -32603, 'Server misconfigured: missing Supabase credentials');
    }

    const sb = createClient(supabaseUrl, supabaseKey);

    try {
      let result: unknown;

      switch (toolName) {
        case 'get_top_picks':
          result = await handleGetTopPicks(sb, toolArgs);
          break;
        case 'get_trending':
          result = await handleGetTrending(sb, toolArgs);
          break;
        case 'search':
          result = await handleSearch(sb, toolArgs);
          break;
        case 'get_new_since':
          result = await handleGetNewSince(sb, toolArgs);
          break;
        case 'get_source_updates':
          result = await handleGetSourceUpdates(sb, toolArgs);
          break;
        case 'check_status':
          result = await handleCheckStatus(sb);
          break;
        default:
          return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
      }

      return jsonRpcResponse(id, {
        content: [result],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonRpcError(id, -32603, message);
    }
  }

  // ─── Unknown method ─────────────────────────────────────────
  return jsonRpcError(id, -32601, `Unknown method: ${method}`);
});
