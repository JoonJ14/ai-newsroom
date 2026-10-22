/**
 * Which code is live. .github/workflows/deploy-mcp.yml overwrites this file
 * with the commit it deploys, just before `supabase functions deploy`, and its
 * smoke test checks that check_status reports that commit. Anywhere else (a
 * local serve, a manual deploy) it says "dev".
 */

export const BUILD_COMMIT: string = 'dev';
export const BUILT_AT: string = '';
