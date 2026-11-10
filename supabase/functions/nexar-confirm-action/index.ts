// NEXAR Confirm Action — Supabase Edge Function
//
// Deployed with gateway JWT verification disabled because it validates the
// session itself with auth.getUser(). Never remove that validation while
// verify_jwt is false.
//
// The decision is made in ONE database transaction by
// public.nexar_confirm_pending_action() (migration 20261110230200):
//   - the request row is locked, so only one answer can act;
//   - the job is refused if it changed since the request was made;
//   - every request records its outcome, which the owner can read back.
// This function only authenticates, validates input and relays the result.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const MAX_BODY_BYTES = 4096;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...CORS,
    },
  });
}

function bearerToken(req: Request): string | null {
  const authorization = req.headers.get('Authorization') ?? '';
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(value);
}

async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// Refusals the caller can act on. Anything else is treated as a server fault.
const REFUSALS = new Set(['not_actionable', 'already_resolved', 'expired', 'target_changed']);
const ACTIONS = new Set(['cancelled', 'deleted', 'already_gone']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  try {
    const jwt = bearerToken(req);
    if (!jwt) return json({ error: 'unauthorized' }, 401);

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userResult, error: userError } =
      await authClient.auth.getUser(jwt);

    if (userError || !userResult?.user) {
      return json({ error: 'invalid_session' }, 401);
    }

    const contentType = req.headers.get('Content-Type') ?? '';
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return json({ error: 'unsupported_media_type' }, 415);
    }

    const rawBody = await readBoundedBody(req, MAX_BODY_BYTES);
    if (!rawBody) {
      return json({ error: 'request_too_large' }, 413);
    }

    let body: any;
    try {
      body = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const actionId = String(body?.action_id ?? '').trim();
    if (!isUuid(actionId)) {
      return json({ error: 'invalid_action_id' }, 400);
    }
    if (typeof body?.accept !== 'boolean') {
      return json({ error: 'invalid_accept' }, 400);
    }

    const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // The user id always comes from the verified session, never from the body.
    const { data: result, error: rpcError } = await serviceClient.rpc(
      'nexar_confirm_pending_action',
      { p_action_id: actionId, p_user_id: userResult.user.id, p_accept: body.accept },
    );

    if (rpcError || !result || typeof result !== 'object') {
      // The transaction rolled back: nothing was deleted and the request is
      // unchanged. The caller reads the request to see where it stands.
      console.error('nexar-confirm-action rpc failed', rpcError);
      return json({ error: 'confirm_failed' }, 500);
    }

    if (result.ok === true && ACTIONS.has(result.action)) {
      return json(result);
    }
    if (result.ok === false && REFUSALS.has(result.error)) {
      return json(result, 409);
    }

    console.error('nexar-confirm-action unexpected result', result);
    return json({ error: 'confirm_failed' }, 500);
  } catch (error) {
    console.error('nexar-confirm-action fatal', error);
    return json({ error: 'internal_error' }, 500);
  }
});
